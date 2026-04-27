const express = require("express");
const router = express.Router();
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const { exec, execSync } = require("child_process");
const pidusage = require("pidusage");
const Joi = require("joi");
const { languages } = require("../services/supported-languages");
const { compileCode } = require("../services/compiler");
const config = require("../config/config");

// Code execution api
router.post("/execute", function (req, res, next) {
  // Validation schema
  const schema = Joi.object({
    language: Joi.string().trim().max(30).required(),
    executionMode: Joi.string()
      .lowercase()
      .trim()
      .valid("file", "code")
      .required(),
    executeFile: Joi.alternatives().conditional("executionMode", [
      {
        is: "file",
        then: Joi.string().trim().max(255).required(),
        otherwise: Joi.optional(),
      },
    ]),
    files: Joi.alternatives().conditional("executionMode", [
      {
        is: "file",
        then: Joi.array()
          .items(
            Joi.object({
              fileName: Joi.string().trim().max(255).required(),
              sourceCode: Joi.string().required(),
            })
          )
          .required(),
        otherwise: Joi.optional(),
      },
    ]),
    code: Joi.alternatives().conditional("executionMode", [
      { is: "code", then: Joi.string().required(), otherwise: Joi.optional() },
    ]),
    stdin: Joi.string().min(0).max(1024).optional(),
    args: Joi.string().min(0).max(1024).optional(),
  });

  // Response schema
  let response = {
    stdout: null,
    stderr: null,
    error: null,
    executionTime: null,
    memoryUsage: null,
    statusCode: null,
  };

  const { error, value } = schema.validate(req.body);
  if (error) {
    response.error = error.details;
    return res.status(400).json(response);
  }

  if (!languages[req.body.language]) {
    let executionStartedAt = performance.now();
    response.error = req.body.language + " is not supported";
    response.executionTime = performance.now() - executionStartedAt;
    return res.json(response);
  }

  if (req.body.language == "html") {
    let executionStartedAt = performance.now();
    if (req.body.executionMode.toLowerCase() == "code") {
      response.stdout = req.body.executeCode;
    } else {
      response.stdout =
        req.body.files.find(function (e) {
          return e.fileName == req.body.executeFile;
        })?.sourceCode ?? "";
    }
    response.executionTime = performance.now() - executionStartedAt;
    return res.json(response);
  }

  let options = {
    encoding: "utf8",
    timeout: 55000,
    maxBuffer: 1024 * 1024 * 50,
    killSignal: "SIGTERM",
    cwd: os.tmpdir(),
    shell: "/bin/bash",
    env: null,
  };

  let timeout = "timeout -k 2 50";
  let executionStartedAt = performance.now();
  const { command, tmpDir } = compileCode(req.body);

  let dbName = path.parse(tmpDir).base.replace(/-/g, "");
  
  // FIXED: Removed 'sudo' from Docker commands
  try {
    if (req.body.language == "mysql") {
      execSync(
        `docker exec -i ${config.container.name} bash -c "${timeout} ${
          languages[req.body.language].compiler
        } -e 'create database ${dbName};'"`
      );
      execSync(
        `docker exec -i ${config.container.name} bash -c "${timeout} ${
          languages[req.body.language].compiler
        } -e 'grant all privileges on ${dbName}.* to compiler@localhost;'"`
      );
    }
  } catch (err) {
    response.executionTime = performance.now() - executionStartedAt;
    response.statusCode = err.status;
    if (err.signal || err.status == 124) {
      response.error = "Sorry maximum execution time limit exceeded.";
    }
    response.stderr = (response.stderr || "") + err.stderr;
    return res.json(response);
  }

  options.cwd = tmpDir;
  const child = exec(command, options);

  pidusage(child.pid, function (err, stats) {
    if (!err && stats.memory) {
      response.memoryUsage = stats.memory;
    }
  });

  child.stdout.on("data", function (stdout) {
    response.stdout = (response.stdout || "") + stdout;
  });
  child.stderr.on("data", function (stderr) {
    response.stderr = (response.stderr || "") + stderr;
  });

  child.on("close", function (status, signal) {
    response.executionTime = performance.now() - executionStartedAt;
    if (signal || status == 124) {
      response.error = "Sorry maximum execution time limit exceeded.";
    }
    response.statusCode = status;

    // FIXED: Removed 'sudo' from here as well
    try {
      if (req.body.language == "mysql") {
        execSync(
          `docker exec -i ${config.container.name} bash -c "${timeout} ${
            languages[req.body.language].compiler
          } -e 'drop database ${dbName};'"`
        );
      }
    } catch (err) {
      // Just log it, don't break the response
    }

    fs.rm(tmpDir, { force: true, recursive: true }, function (err) {
      // Tmp dir cleanup
    });
    return res.json(response);
  });
});

router.get("/languages", function (req, res, next) {
  let response = [];
  for (const [key, value] of Object.entries(languages)) {
    response.push({
      languageName: value.languageName,
      language: value.language,
      version: value.version,
      fileExtension: value.fileExtension,
      fileName: value.fileName,
      defaultCode: value.defaultCode,
    });
  }
  return res.json(response);
});

module.exports = router;
                          
