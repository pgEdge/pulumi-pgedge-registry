const util = require("util");
const exec = util.promisify(require("child_process").exec);
const fs = require("fs");
const path = require("path");
const AWS = require("aws-sdk");
const yaml = require("yaml");

const batchSize = 8;

// List of the larger packages to process syncronously (not as part of a batch). They
// have been causing out of memory issues so process them by themselves to mitigate this.
// In addtion the processing will be split into two halves, so each half of the pages will
// process separately.
const singles = [
    "aws",
    "aws-native",
    "azure",
    "azure-native",
    "azure-native-v1",
    "gcp",
    "google-native",
    "kubernetes",
    "alicloud",
    "oci",
    "fortios",
];

// Retry queue to process failed packages.
const retry = [];

const allPkgs = getPackagesMetadata();
const pkgs = allPkgs.filter((pkg) => !singles.includes(pkg.name));
const largePkgs = allPkgs.filter((pkg) => singles.includes(pkg.name));

const results = {
    tests: 0,
    passes: 0,
    failures: 0,
    start: 0,
    end: 0,
    duration: 0,
    failedPages: [],
    failedPageCount: 0,
    totalPageCount: 0,
};

async function runTests() {
    async function processSync(pkgs, split) {
        for (let pkgMetadata of pkgs) {
            if (split) {
                // process first half of pages.
                await exec(
                    `npm run test-api-docs -- --pkg=${pkgMetadata.name} --split=1 || true`,
                ).then((stdout, stderr) => {
                    console.log(stdout);
                    console.log("processed:", pkgMetadata.name);
                    processJSON(stdout, stderr, pkgMetadata);
                });
                // process second half of pages.
                await exec(
                    `npm run test-api-docs -- --pkg=${pkgMetadata.name} --split=2 || true`,
                ).then((stdout, stderr) => {
                    console.log(stdout);
                    console.log("processed:", pkgMetadata.name);
                    processJSON(stdout, stderr, pkgMetadata);
                });
            } else {
                // Do not split, process all pages in package.
                await exec(
                    `npm run test-api-docs -- --pkg=${pkgMetadata.name} --split=0 || true`,
                ).then((stdout, stderr) => {
                    console.log(stdout);
                    console.log("processed:", pkgMetadata.name);
                    processJSON(stdout, stderr, pkgMetadata);
                });
            }
        }
    }

    async function processBatches(pkgs, size) {
        for (let i = 0; i < pkgs.length; i += size) {
            const batch = pkgs.slice(i, i + size);
            // Shell out to run test for package. This causes it to fork sepatate node processes for each package
            // being tested. This enables us to test many packages since each node process has its own memory space,
            // so we do not run out of heap memory.
            const runs = batch.map((pkgMetadata) => {
                return exec(
                    `npm run test-api-docs -- --pkg=${pkgMetadata.name} --split=0 || true`,
                ).then((stdout, stderr) => {
                    console.log(stdout);
                    console.log("processed:", pkgMetadata.name);
                    processJSON(stdout, stderr, pkgMetadata);
                });
            });
            console.log("processing batch:", i, "-", i + size);
            await Promise.all(runs).then(() => {
                console.log("batch done:", i, "-", i + size);
            });
        }
    }

    // Batch process smaller packages.
    await processBatches(pkgs, batchSize, false);
    // Process retry queue syncronously.
    await processSync(retry, false);
    // Process the larger packages syncronously.
    await processSync(largePkgs, true);

    console.log(results);
    await pushResultsS3(results);
}

runTests();

function processJSON(stdout, stderr, pkgMetadata) {
    const contents = fs.readFileSync("ctrf/ctrf-report.json", {
        encoding: "utf8",
    });
    const results = JSON.parse(contents);

    // The test results get written to ctrf/ctrf-report.json, and since we process in batches asyncronoulsy, there
    // is the potential for a reace condition where before the test results are read from the file another package
    // test could have written to it, so we verify the results match the package being processed and if not, add
    // to retry queue to be processed syncronously later.
    if (!results.results.tests[0].name.includes(`${pkgMetadata.name}/`)) {
        retry.push(pkgMetadata);
        return;
    }

    transformResults(results, pkgMetadata);

    // The cli command error is trapped here since it is a sub process of this script.
    // Checking if error here will enable us to mark this as a failed run by exiting
    // unsuccessfully. Otherwise the run will always pass successfully regardless of
    // the result of the tests.
    if (stderr) {
        console.error("errors:", stderr);
        process.exit(1);
    }
}

// Transform results into the structure we want and add them to the results object that will get pushed
// to s3 once all the tests complete.
function transformResults(res, pkgMetadata) {
    const summary = res.results.summary;
    results.tests += summary.tests;
    results.passes += summary.passed;
    results.failures += summary.failed;
    results.start = summary.start;
    results.end = summary.stop;
    results.duration = summary.stop - summary.start;
    results.ghRunURL = getRunUrl();

    // Track total count of pages.
    const allPages = new Set();
    res.results.tests.forEach((t) => {
        const { url, _ } = extractTestInfo(t.name);
        allPages.add(url);
    });

    // Get list of failed pages.
    const failedPages = [];
    // iterate over test failures and add page url to failedPages array.
    res.results.tests
        .filter((t) => t.status !== "passed")
        .forEach((t) => {
            const { url, description } = extractTestInfo(t.name);
            failedPages.push({
                url,
                description,
            });
        });

    // dedupe pages and keep track of a count for each page failure occurance to map
    // the page to the number of failure occurances for each page.
    const pageMap = {};
    failedPages.forEach((page) => {
        pageMap[page.url] = {
            count: pageMap[page.url] ? pageMap[page.url].count + 1 : 1,
            failureMsg: pageMap[page.url]
                ? (pageMap[page.url].failureMsg || "") +
                  " | " +
                  page.description
                : page.description,
        };
    });

    // Convert pageMap to an array of objects with failure counts. This
    results.failedPages = [
        ...results.failedPages,
        ...Object.keys(pageMap).map((key) => ({
            page: key,
            failures: pageMap[key].count,
            reason: pageMap[key].failureMsg,
            tests: 15,
            package: pkgMetadata.name,
            type: resolvePackageType(pkgMetadata),
            repo: pkgMetadata.repo_url,
        })),
    ];

    results.failedPageCount =
        Object.keys(pageMap).length + results.failedPageCount;
    results.totalPageCount = allPages.size + results.totalPageCount;
    return results;
}

function extractTestInfo(msg) {
    const urlRegex = /^(https?:\/\/[^)]+\/)/;
    const match = msg.match(urlRegex);
    const url = match ? match[0] : null;
    const description = msg.replace(url, "");
    return { url, description };
}

function getRunUrl() {
    const serverUrl = process.env.GITHUB_SERVER_URL;
    const repo = process.env.GITHUB_REPOSITORY;
    const runId = process.env.GITHUB_RUN_ID;
    const runAttempt = process.env.GITHUB_RUN_ATTEMPT;

    return (
        serverUrl +
        "/" +
        repo +
        "/actions/runs/" +
        runId +
        "/attempts/" +
        runAttempt
    );
}

// expand date string to return yyyy, mm, dd
function expandDate(dateString) {
    const date = new Date(dateString);
    const year = date.getFullYear();
    const monthNumber = date.getMonth() + 1; // zero indexed, so add 1 to get month number
    const month = `${monthNumber < 10 ? `0${monthNumber}` : monthNumber}`;
    const dayNumber = date.getDate();
    const day = `${dayNumber < 10 ? `0${dayNumber}` : dayNumber}`;
    return { year, month, day };
}

// upload to S3 with yyyy/mm/dd prefix.
async function pushResultsS3(obj) {
    const bucketName = "pulumi-api-docs-e2e-test-results-prodution";

    const jsonData = JSON.stringify(obj);
    // extract yyyy, mm, dd from date.
    const { year, month, day } = expandDate(obj.start);

    // Write JSON to file
    const filename = "results.json";
    fs.writeFileSync(filename, jsonData);

    // Upload JSON file to S3 bucket
    console.log("pushing to S3");
    const s3 = new AWS.S3();
    const key = `${year}/${month}/${day}/results.json`;

    const uploadParams = {
        Bucket: bucketName,
        Key: key,
        Body: fs.createReadStream(filename),
    };

    return s3.upload(uploadParams).promise();
}

// Load package metadata from metadata files, convert YAML to JSON object,
// then return array containing package metadata. 
function getPackagesMetadata() {
    const dirPath = "./themes/default/data/registry/packages/";
    const files = fs.readdirSync(dirPath);
    const yamlFiles = files.filter((file) => file.endsWith(".yaml"));
    const packageMetadata = [];

    yamlFiles.forEach((file) => {
        const filePath = path.join(dirPath, file);
        const fileContents = fs.readFileSync(filePath, "utf8");
        const jsonObject = yaml.parse(fileContents);
        packageMetadata.push(jsonObject);
    });

    return packageMetadata;
}

function resolvePackageType(pkg) {
    const isComponent = pkg.component;
    const isNative = pkg.native;

    if (isComponent) {
        return "component";
    } else if (isNative) {
        return "native";
    } else {
        return "bridged";
    }
}
