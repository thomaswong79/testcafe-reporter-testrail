// API reference: http://docs.gurock.com/testrail-api2/start

import FormData from "form-data";
import fs from "fs";
import qs, { ParsedUrlQueryInput } from "querystring";
import fetch from "node-fetch";

import { separator } from "./utils";
import {
  Options,
  Reporter,
  Project,
  Plan,
  Suite,
  Run,
  Result,
  NewResult,
  PlanEntry,
  Case,
  NewCase,
  NewResultByCase,
  TestResult,
  Test,
} from "./interfaces";

enum HttpMethod {
  Get = "get",
  Post = "post",
}

export class TestRail {
  host: string;
  baseUrl: string;
  authHeader: string;

  logger: Reporter;
  chalk: Reporter["chalk"];
  moment: Reporter["moment"];

  constructor(
    options: { host: string; user: string; password: string },
    reporter: Reporter
  ) {
    this.host = options.host;
    this.baseUrl = "/index.php?/api/v2/";
    this.authHeader =
      "Basic " +
      Buffer.from(options.user + ":" + options.password).toString("base64");

    this.logger = reporter;
    this.chalk = reporter.chalk;
    this.moment = reporter.moment;
  }

  printError = async (error: string) => {
    this.logger
      .newline()
      .write(this.chalk.red.bold(`Error: ${error}`))
      .newline();
  };

  testConnection = async () => {
    this.logger
      .newline()
      .write(separator)
      .newline()
      .write(this.chalk.green("Testing connection to TestRail..."));

    try {
      await this.getProjects();
    } catch (error) {
      this.printError(
        "Connection to TestRail instance could not be established."
      );
      process.exit(1);
    }

    this.logger
      .write(this.chalk.green("Done"))
      .newline()
      .write(separator)
      .newline();
  };

  getProjectId = async (projectName: string, projectId: string) => {
    try {
      let project: Project | undefined;

      const projects = await this.getProjects();
      if (projectId) {
        const pid = Number(projectId.replace("P", ""));
        project = projects.find((project: Project) => project.id === pid);
      } else {
        project = projects.find(
          (project: Project) => project.name === projectName
        );
      }

      if (project && project.id) {
        this.logger
          .write(
            `${this.chalk.blue.bold("Project name (id)")} ${this.chalk.yellow(
              `${project.name} (${project.id})`
            )}`
          )
          .newline();

        return project.id;
      } else {
        this.printError("Project does not exist.");
        process.exit(1);
      }
    } catch (error) {
      this.printError("Could not retrieve project list.");
      this.logger.write(error.toString()).newline();
      process.exit(1);
    }
  };

  getPlanId = async (planName: string, planId: string, projectId: number) => {
    try {
      if (!planName && !planId) {
        return undefined;
      }

      let plan;
      const plans = await this.getPlans(projectId);
      if (planId) {
        const pid = Number(planId.replace("R", ""));
        plan = plans.find((plan: Plan) => plan.id === pid);
      } else {
        plan = plans.find((plan: Plan) => plan.name === planName);
      }

      if (plan && plan.id) {
        this.logger
          .write(
            `${this.chalk.blue.bold("Plan name (id)")} ${this.chalk.yellow(
              `${plan.name} (${plan.id})`
            )}`
          )
          .newline();

        return plan.id;
      } else {
        this.printError("Plan does not exist.");
        process.exit(1);
      }
    } catch (error) {
      this.printError("Could not retrieve plan list.");
      this.logger.write(error.toString()).newline();
      process.exit(1);
    }
  };

  getSuiteId = async (
    suiteName: string,
    suiteId: string,
    projectId: number
  ) => {
    try {
      let suite;
      const suites = await this.getSuites(projectId);
      if (suiteId) {
        const sid = Number(suiteId.replace("S", ""));
        suite = suites.find((suite) => suite.id === sid);
      } else {
        suite = suites.find((suite) => suite.name === suiteName);
      }

      if (suite && suite.id) {
        this.logger
          .write(
            `${this.chalk.blue.bold("Suite name (id)")} ${this.chalk.yellow(
              `${suite.name} (${suite.id})`
            )}`
          )
          .newline();

        return suite.id;
      } else {
        this.printError("Suite does not exist.");
        process.exit(1);
      }
    } catch (error) {
      this.printError("Could not retrieve suite list.");
      this.logger.write(error.toString()).newline();
      process.exit(1);
    }
  };

  closeOldRuns = async (projectId: number, options: Options) => {
    if (options.runCloseAfterDays) {
      const runs = await this.getRuns(projectId);
      runs.forEach(async (run: Run) => {
        if (
          !run.is_completed &&
          this.moment.unix(run.created_on) <=
            this.moment().subtract(options.runCloseAfterDays, "days")
        ) {
          this.logger.write("Closing outdated run: " + run.name).newline();
          await this.closeRun(run.id);
        }
      });
    }
  };

  publishTestResults = async (
    run: Run,
    results: NewResultByCase[],
    testResults: TestResult[],
    options: Options
  ) => {
    const payload = {
      results,
    };

    try {
      const runId = run.id;
      const results = await this.addResultsForCases(runId, payload);
      const tests = await this.getTests(runId);

      if (options.uploadScreenshots) {
        for (const testResult of testResults) {
          const test = tests.find((test) => test.case_id === testResult.caseId);
          const result = results.find((result) => result.test_id === test?.id);
          if (result) {
            for (const screenshot of testResult.testRunInfo.screenshots) {
              await this.addAttachmentToResult(
                result.id,
                screenshot.screenshotPath
              );
            }
          }
        }
      }

      if (results.length == 0) {
        this.logger
          .newline()
          .write(
            this.chalk.yellow(
              "Warning: No Data has been published to Testrail."
            )
          )
          .newline();
      } else {
        this.logger
          .newline()
          .write("------------------------------------------------------")
          .newline()
          .write(this.chalk.green("Result added to the testrail successfully."))
          .newline()
          .newline();
      }
    } catch (error) {
      this.printError("Could not post test results.");
      this.logger.write(error.toString()).newline();
      process.exit(1);
    }
  };

  publishTestRun = async (
    options: Options,
    testResults: TestResult[],
    userAgents: string[]
  ) => {
    this.logger
      .newline()
      .write(separator)
      .newline()
      .write(this.chalk.green("Publishing the results to testrail..."))
      .newline();

    const results: NewResultByCase[] = [];
    const caseIdList: number[] = [];

    testResults.forEach((testResult) => {
      if (testResult.caseId > 0) {
        const errorLog = testResult.testRunInfo.errs
          .map((x: object) =>
            this.logger
              .formatError(x)
              .replace(
                /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
                ""
              )
          )
          .join("\n");

        const result: NewResultByCase = {
          case_id: testResult.caseId,
          status_id: testResult.testStatus.value,
          comment: `Test ${testResult.testStatus.text}\n${errorLog}`,
        };

        results.push(result);
        caseIdList.push(testResult.caseId);
      } else {
        this.logger
          .write(
            `Warning: Test ${this.chalk.yellow(
              testResult.name
            )} missing the TestRail Case ID in test metadata`
          )
          .newline();
      }
    });

    if (results.length) {
      const projectId = await this.getProjectId(
        options.project,
        options.projectId
      );
      const planId = await this.getPlanId(
        options.plan,
        options.planId,
        projectId
      );
      const suiteId = await this.getSuiteId(
        options.suite,
        options.suiteId,
        projectId
      );

      const creationDate = this.moment().format("YYYY-MM-DD HH:mm:ss");

      let runName = "";
      if (options.runName) {
        runName = options.runName
          .replace("%DATE%", creationDate)
          .replace("%AGENTS%", `(${userAgents.join(", ")})`);
      } else {
        runName = `${creationDate} (${userAgents.join(", ")})`;
      }

      const payload = {
        suite_id: suiteId,
        include_all: false,
        case_ids: caseIdList,
        name: runName,
        description: options.runDescription,
      };

      try {
        let run: Run;
        if (planId) {
          const planEntry = await this.addPlanEntry(planId, payload);
          run = planEntry.runs[0];
        } else {
          await this.closeOldRuns(projectId, options);
          run = await this.addRun(projectId, payload);
        }

        this.logger
          .newline()
          .write(separator)
          .newline()
          .write(this.chalk.green("Run added successfully."))
          .newline()
          .write(`${this.chalk.blue.bold("Run name")} ${runName}`)
          .newline();

        await this.publishTestResults(run, results, testResults, options);
      } catch (error) {
        this.printError("Could not post test results.");
        this.logger.write(error.toString()).newline();
        process.exit(1);
      }
    } else {
      this.logger
        .newline()
        .write(this.chalk.red.bold(this.logger.symbols.err))
        .write("No test case data found to publish")
        .newline();
    }
  };

  // API

  _callAPI = async <T>(
    method: HttpMethod,
    apiUrl: string,
    queryVariables: ParsedUrlQueryInput | undefined,
    body?: object
  ) => {
    const requestBody = body ? JSON.stringify(body) : undefined;
    let url = this.host + this.baseUrl + apiUrl;

    if (queryVariables != null) {
      url += "&" + qs.stringify(queryVariables);
    }

    return fetch(url, {
      method,
      body: requestBody,
      headers: {
        "Content-Type": "application/json",
        accept: "application/json",
        Authorization: this.authHeader,
      },
    }).then((res): Promise<T> => res.json());
  };

  apiGet = <T>(
    apiUrl: string,
    queryVariables: ParsedUrlQueryInput | undefined = undefined
  ) => {
    return this._callAPI<T>(HttpMethod.Get, apiUrl, queryVariables);
  };

  apiPost = <T>(
    apiUrl: string,
    body: any = undefined,
    queryVariables: ParsedUrlQueryInput | undefined = undefined
  ) => {
    return this._callAPI<T>(HttpMethod.Post, apiUrl, queryVariables, body);
  };

  // ----- Cases -----

  getCase = (id: number) => {
    return this.apiGet<Case>("get_case/" + id);
  };

  getCases = (project_id: number, filters?: ParsedUrlQueryInput) => {
    return this.apiGet<Case[]>("get_cases/" + project_id, filters);
  };

  addCase = (section_id: number, data: NewCase) => {
    return this.apiPost<Case>("add_case/" + section_id, data);
  };

  updateCase = (case_id: number, data: NewCase) => {
    return this.apiPost("update_case/" + case_id, data);
  };

  deleteCase = (case_id: number) => {
    return this.apiPost("delete_case/" + case_id);
  };

  // ----- Case Fields -----

  getCaseFields = () => {
    return this.apiGet("get_case_fields");
  };

  // ----- Case Types -----

  getCaseTypes = () => {
    return this.apiGet("get_case_types");
  };

  // ----- Configurations -----

  getConfigs = (project_id: number) => {
    return this.apiGet("get_configs/" + project_id);
  };

  addConfigGroup = (project_id: number, data: any) => {
    return this.apiPost("add_config_group/" + project_id, data);
  };

  addConfig = (config_group_id: number, data: any) => {
    return this.apiPost("add_config/" + config_group_id, data);
  };

  updateConfigGroup = (config_group_id: number, data: any) => {
    return this.apiPost("update_config_group/" + config_group_id, data);
  };

  updateConfig = (config_id: number, data: any) => {
    return this.apiPost("update_config/" + config_id, data);
  };

  deleteConfigGroup = (config_group_id: number) => {
    return this.apiPost("delete_config_group/" + config_group_id);
  };

  deleteConfig = (config_id: number) => {
    return this.apiPost("delete_config/" + config_id);
  };

  // ----- Milestones -----

  getMilestone = (id: number) => {
    return this.apiGet("get_milestone/" + id);
  };

  getMilestones = (project_id: number, filters?: ParsedUrlQueryInput) => {
    return this.apiGet("get_milestones/" + project_id, filters);
  };

  addMilestone = (project_id: number, data: any) => {
    return this.apiPost("add_milestone/" + project_id, data);
  };

  updateMilestone = (milestone_id: number, data: any) => {
    return this.apiPost("update_milestone/" + milestone_id, data);
  };

  deleteMilestone = (milestone_id: number) => {
    return this.apiPost("delete_milestone/" + milestone_id);
  };

  // ----- Plans -----

  getPlan = (id: number) => {
    return this.apiGet("get_plan/" + id);
  };

  getPlans = (project_id: number, filters?: ParsedUrlQueryInput) => {
    return this.apiGet<Plan[]>("get_plans/" + project_id, filters);
  };

  addPlan = (project_id: number, data: any) => {
    return this.apiPost("add_plan/" + project_id, data);
  };

  addPlanEntry = (plan_id: number, data: any) => {
    return this.apiPost<PlanEntry>("add_plan_entry/" + plan_id, data);
  };

  updatePlan = (plan_id: number, data: any) => {
    return this.apiPost("update_plan/" + plan_id, data);
  };

  updatePlanEntry = (plan_id: number, entry_id: number, data: any) => {
    return this.apiPost("update_plan_entry/" + plan_id + "/" + entry_id, data);
  };

  closePlan = (plan_id: number) => {
    return this.apiPost("close_plan/" + plan_id);
  };

  deletePlan = (plan_id: number) => {
    return this.apiPost("delete_plan/" + plan_id);
  };

  deletePlanEntry = (plan_id: number, entry_id: number) => {
    return this.apiPost("delete_plan_entry/" + plan_id + "/" + entry_id);
  };

  // ----- Priorities -----

  getPriorities = () => {
    return this.apiGet("get_priorities");
  };

  // ----- Projects -----

  getProject = (id: number) => {
    return this.apiGet("get_project/" + id);
  };

  getProjects = (filters?: ParsedUrlQueryInput) => {
    return this.apiGet<Project[]>("get_projects", filters);
  };

  addProject = (data: any) => {
    return this.apiPost("add_project", data);
  };

  updateProject = (project_id: number, data: any) => {
    return this.apiPost("update_project/" + project_id, data);
  };

  deleteProject = (project_id: number) => {
    return this.apiPost("delete_project/" + project_id);
  };

  // ----- Results -----

  getResults = (test_id: number, filters?: ParsedUrlQueryInput) => {
    return this.apiGet<Result[]>("get_results/" + test_id, filters);
  };

  getResultsForCase = (
    run_id: number,
    case_id: number,
    filters?: ParsedUrlQueryInput
  ) => {
    return this.apiGet<Result[]>(
      "get_results_for_case/" + run_id + "/" + case_id,
      filters
    );
  };

  getResultsForRun = (run_id: number, filters?: ParsedUrlQueryInput) => {
    return this.apiGet<Result[]>("get_results_for_run/" + run_id, filters);
  };

  addResult = (test_id: number, data: NewResult) => {
    return this.apiPost<Result>("add_result/" + test_id, data);
  };

  addResultForCase = (run_id: number, case_id: number, data: NewResult) => {
    return this.apiPost<Result>(
      "add_result_for_case/" + run_id + "/" + case_id,
      data
    );
  };

  addResults = (run_id: number, data: NewResult) => {
    return this.apiPost<Result[]>("add_results/" + run_id, data);
  };

  addResultsForCases = (
    run_id: number,
    data: { results: NewResultByCase[] }
  ) => {
    return this.apiPost<Result[]>("add_results_for_cases/" + run_id, data);
  };

  // ----- Result Fields -----

  getResultFields = () => {
    return this.apiGet("get_result_fields");
  };

  // ----- Runs -----

  getRun = (id: number) => {
    return this.apiGet<Run>("get_run/" + id);
  };

  getRuns = (project_id: number, filters?: ParsedUrlQueryInput) => {
    return this.apiGet<Run[]>("get_runs/" + project_id, filters);
  };

  addRun = (project_id: number, data: any) => {
    return this.apiPost<Run>("add_run/" + project_id, data);
  };

  updateRun = (run_id: number, data: any) => {
    return this.apiPost("update_run/" + run_id, data);
  };

  closeRun = (run_id: number) => {
    return this.apiPost("close_run/" + run_id);
  };

  deleteRun = (run_id: number) => {
    return this.apiPost("delete_run/" + run_id);
  };

  // ----- Sections -----

  getSection = (id: number) => {
    return this.apiGet("get_section/" + id);
  };

  getSections = (project_id: number, filters?: ParsedUrlQueryInput) => {
    return this.apiGet("get_sections/" + project_id, filters);
  };

  addSection = (project_id: number, data: any) => {
    return this.apiPost("add_section/" + project_id, data);
  };

  updateSection = (section_id: number, data: any) => {
    return this.apiPost("update_section/" + section_id, data);
  };

  deleteSection = (section_id: number) => {
    return this.apiPost("delete_section/" + section_id);
  };

  // ----- Statuses -----

  getStatuses = () => {
    return this.apiGet("get_statuses");
  };

  // ----- Suites -----

  getSuite = (id: number) => {
    return this.apiGet("get_suite/" + id);
  };

  getSuites = (project_id: number) => {
    return this.apiGet<Suite[]>("get_suites/" + project_id);
  };

  addSuite = (project_id: number, data: any) => {
    return this.apiPost("add_suite/" + project_id, data);
  };

  updateSuite = (suite_id: number, data: any) => {
    return this.apiPost("update_suite/" + suite_id, data);
  };

  deleteSuite = (suite_id: number) => {
    return this.apiPost("delete_suite/" + suite_id);
  };

  // ----- Templates -----

  getTemplates = (project_id: number) => {
    return this.apiGet("get_templates/" + project_id);
  };

  // ----- Tests -----

  getTest = (id: number) => {
    return this.apiGet<Test>("get_test/" + id);
  };

  getTests = (run_id: number, filters?: ParsedUrlQueryInput) => {
    return this.apiGet<Test[]>("get_tests/" + run_id, filters);
  };

  // ----- Users -----

  getUser = (id: number) => {
    return this.apiGet("get_user/" + id);
  };

  getUserByEmail = (email: string) => {
    return this.apiGet("get_user_by_email", { email: email });
  };

  getUsers = () => {
    return this.apiGet("get_users");
  };

  // ----- Attachments -----

  addAttachmentToResult = async (result_id: number, filePath: string) => {
    const url =
      this.host + this.baseUrl + "add_attachment_to_result/" + result_id;

    const fd = new FormData();
    fd.append("attachment", fs.createReadStream(filePath));

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
      },
      body: fd,
    });
    return await res.json();
  };
}