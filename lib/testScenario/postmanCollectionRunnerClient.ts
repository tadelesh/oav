import path, { dirname } from "path";
import newman from "newman";
import {
  VariableScope,
  Collection,
  Header,
  Item,
  Request,
  RequestBody,
  RequestBodyDefinition,
  Url,
  UrlDefinition,
  Event,
  QueryParamDefinition,
  VariableDefinition,
  ItemDefinition,
} from "postman-collection";

import { inject, injectable } from "inversify";
import { JsonLoader, JsonLoaderOption } from "../swagger/jsonLoader";
import { setDefaultOpts } from "../swagger/loader";
import { printWarning } from "../util/utils";
import { ValidationLevel } from "./reportGenerator";
import { SwaggerAnalyzer } from "./swaggerAnalyzer";
import { DataMasker } from "./dataMasker";
import { FileLoader } from "./../swagger/fileLoader";
import { NewmanReportAnalyzer, NewmanReportAnalyzerOption } from "./postmanReportAnalyzer";
import { inversifyGetInstance, TYPES } from "./../inversifyUtils";
import { BlobUploader, BlobUploaderOption } from "./blobUploader";
import { PostmanTestScript, TestScriptType } from "./postmanTestScript";
import {
  ArmTemplate,
  TestDefinitionFile,
  TestStepArmTemplateDeployment,
  TestStepRestCall,
} from "./testResourceTypes";
import {
  ArmDeploymentTracking,
  TestScenarioClientRequest,
  TestScenarioRunnerClient,
  TestStepEnv,
} from "./testScenarioRunner";
import { ReflectiveVariableEnv, VariableEnv } from "./variableEnv";
import { typeToDescription } from "./postmanItemTypes";
import {
  generatedGet,
  lroPollingUrl,
  generatedPostmanItem,
  defaultCollectionFileName,
  defaultEnvFileName,
  defaultNewmanReport,
} from "./defaultNaming";
import { NewmanReport } from "./postmanReportParser";
import { RuntimeEnvManager } from "./runtimeEnvManager";

export interface PostmanCollectionRunnerClientOption extends BlobUploaderOption, JsonLoaderOption {
  testScenarioFileName: string;
  enableBlobUploader: boolean;
  env: VariableEnv;
  testDef?: TestDefinitionFile;
  testScenarioFilePath?: string;
  reportOutputFolder?: string;
  markdownReportPath?: string;
  junitReportPath?: string;
  testScenarioName: string;
  runId: string;
  jsonLoader?: JsonLoader;
  swaggerFilePaths?: string[];
  baseUrl: string;
  validationLevel?: ValidationLevel;
  skipCleanUp?: boolean;
  from?: string;
  to?: string;
  verbose?: boolean;
}

function makeid(length: number): string {
  let text = "";
  const possible = "abcdefghijklmnopqrstuvwxyz0123456789";

  for (let i = 0; i < length; i++)
    text += possible.charAt(Math.floor(Math.random() * possible.length));

  return text;
}

export const generateRunId = (): string => {
  const today = new Date();
  const yyyy = today.getFullYear().toString();
  const MM = pad(today.getMonth() + 1, 2);
  const dd = pad(today.getDate(), 2);
  const hh = pad(today.getHours(), 2);
  const mm = pad(today.getMinutes(), 2);
  const id = makeid(5);
  return yyyy + MM + dd + hh + mm + "-" + id;
};

function pad(number: number, length: number) {
  let str = "" + number;
  while (str.length < length) {
    str = "0" + str;
  }
  return str;
}

@injectable()
export class PostmanCollectionRunnerClient implements TestScenarioRunnerClient {
  public collection: Collection;
  public collectionEnv: VariableScope;
  private postmanTestScript: PostmanTestScript;
  private stepNameSet: Map<string, number>;
  // eslint-disable-next-line @typescript-eslint/explicit-member-accessibility
  constructor(
    @inject(TYPES.opts) private opts: PostmanCollectionRunnerClientOption,
    private blobUploader: BlobUploader,
    private dataMasker: DataMasker,
    private swaggerAnalyzer: SwaggerAnalyzer,
    private fileLoader: FileLoader
  ) {
    setDefaultOpts(this.opts, {
      testScenarioFileName: "",
      testScenarioFilePath: "",
      env: new VariableEnv(),
      reportOutputFolder: path.resolve(process.cwd(), "newman"),
      enableBlobUploader: false,
      runId: generateRunId(),
      testScenarioName: "",
      blobConnectionString: process.env.blobConnectionString || "",
      baseUrl: "https://management.azure.com",
    });
    this.stepNameSet = new Map<string, number>();
    this.collection = new Collection();
    this.collection.name = this.opts.testScenarioFileName;
    this.collection.id = this.opts.runId!;
    this.collection.describe(
      JSON.stringify({
        testScenarioFilePath: this.opts.testScenarioFilePath,
        testScenarioName: this.opts.testScenarioName,
      })
    );
    this.collectionEnv = new VariableScope({});
    this.collectionEnv.set("bearerToken", "<bearerToken>", "string");
    this.postmanTestScript = new PostmanTestScript();
  }
  public async createResourceGroup(
    subscriptionId: string,
    resourceGroupName: string,
    location: string
  ): Promise<void> {
    this.auth(this.opts.env);
    const item = new Item({
      name: "createResourceGroup",
      request: {
        url: `${this.opts.baseUrl}/subscriptions/${subscriptionId}/resourcegroups/{{resourceGroupName}}?api-version=2020-06-01`,
        method: "put",
        body: {
          mode: "raw",
          raw: JSON.stringify({ location: location }),
        },
      },
    });
    item.description = typeToDescription({ type: "prepare" });
    const authorizationHeader = new Header({
      key: "Authorization",
      value: `Bearer {{bearerToken}}`,
    });
    item.request.addHeader(new Header({ key: "Content-Type", value: "application/json" }));
    item.request.addHeader(authorizationHeader);
    this.addTestScript(item);
    this.collection.items.add(item);
    this.collectionEnv.set("resourceGroupName", resourceGroupName, "string");
  }
  public async deleteResourceGroup(
    subscriptionId: string,
    _resourceGroupName: string
  ): Promise<void> {
    if (this.opts.from || this.opts.to) {
      return;
    }
    const item = new Item({
      name: "deleteResourceGroup",
      request: {
        url: `${this.opts.baseUrl}/subscriptions/${subscriptionId}/resourcegroups/{{resourceGroupName}}?api-version=2020-06-01`,
        method: "delete",
      },
    });
    const authorizationHeader = new Header({
      key: "Authorization",
      value: `Bearer {{bearerToken}}`,
    });
    item.request.addHeader(new Header({ key: "Content-Type", value: "application/json" }));
    item.request.addHeader(authorizationHeader);
    item.events.add(
      new Event({
        listen: "test",
        script: {
          type: "text/javascript",
          exec: this.postmanTestScript.generateScript({
            name: "response code should be 2xx",
            types: ["StatusCodeAssertion"],
          }),
        },
      })
    );
    this.addAsLongRunningOperationItem(item);
  }

  public async sendExampleRequest(
    request: TestScenarioClientRequest,
    step: TestStepRestCall,
    stepEnv: TestStepEnv
  ): Promise<void> {
    this.auth(stepEnv.env);
    const pathEnv = new ReflectiveVariableEnv(":", "");
    const item = new Item();
    if (!this.stepNameSet.has(step.step!)) {
      item.name = step.step!;
      this.stepNameSet.set(step.step, 0);
    } else {
      const cnt = this.stepNameSet.get(step.step!)! + 1;
      item.name = `${step.step}_${cnt}`;
      this.stepNameSet.set(step.step, cnt);
    }
    item.request = new Request({
      name: step.exampleFilePath,
      method: step.operation._method as string,
      url: "",
      body: { mode: "raw" } as RequestBodyDefinition,
    });
    item.description = step.operation.operationId || "";
    const queryParams: QueryParamDefinition[] = [];
    const urlVariables: VariableDefinition[] = [];
    for (const p of step.operation.parameters ?? []) {
      const param = this.opts.jsonLoader!.resolveRefObj(p);
      const paramValue = stepEnv.env.get(param.name) || step.requestParameters[param.name];
      const paramName = Object.keys(step.variables).includes(param.name)
        ? `${item.name}_${param.name}`
        : param.name;
      if (!this.collectionEnv.has(paramName)) {
        this.collectionEnv.set(paramName, paramValue, typeof step.requestParameters[param.name]);
      }

      switch (param.in) {
        case "path":
          urlVariables.push({ key: param.name, value: `{{${paramName}}}` });
          break;
        case "query":
          if (paramValue !== undefined) {
            queryParams.push({ key: param.name, value: paramValue });
          }
          break;
        case "header":
          const header = new Header({ key: param.name, value: paramValue });
          item.request.headers.add(header);
          break;
        case "body":
          item.request.body = new RequestBody({
            mode: "raw",
            raw: JSON.stringify(stepEnv.env.resolveObjectValues(request.body), null, 2),
          });
          break;
        default:
          throw new Error(`Parameter "in" not supported: ${param.in}`);
      }
      this.collection.items.add(item);
    }
    const authorizationHeader = new Header({
      key: "Authorization",
      value: `Bearer {{bearerToken}}`,
    });
    const contentType = new Header({ key: "Content-Type", value: "application/json" });
    item.request.addHeader(contentType);
    item.request.addHeader(authorizationHeader);

    const getOverwriteVariables = () => {
      if (step.outputVariables !== undefined && Object.keys(step.outputVariables).length > 0) {
        const ret = new Map<string, string>();
        for (const k of Object.keys(step.outputVariables)) {
          ret.set(k, step.outputVariables[k].fromResponse);
        }
        return ret;
      }
      return undefined;
    };
    for (const k of Object.keys(step.outputVariables)) {
      stepEnv.env.set(k, `{{${k}}}`);
    }
    const scriptTypes: TestScriptType[] = this.opts.verbose
      ? ["DetailResponseLog", "StatusCodeAssertion"]
      : ["StatusCodeAssertion"];
    this.addTestScript(item, scriptTypes, getOverwriteVariables());
    item.request.url = new Url({
      path: pathEnv.resolveString(step.operation._path._pathTemplate, "{", "}"),
      host: this.opts.baseUrl,
      variable: urlVariables,
    } as UrlDefinition);
    item.request.addQueryParams(queryParams);

    if (step.operation["x-ms-long-running-operation"]) {
      item.description = typeToDescription({
        type: "LRO",
        poller_item_name: `${item.name}_poller`,
        operationId: step.operation.operationId || "",
        exampleName: step.exampleFile!,
        itemName: item.name,
        step: item.name,
      });
      this.addAsLongRunningOperationItem(item);
    } else {
      item.description = typeToDescription({
        type: "simple",
        operationId: step.operation.operationId || "",
        exampleName: step.exampleFile!,
        itemName: item.name,
        step: item.name,
      });
      this.collection.items.add(item);
    }
    // generate get
    if (step.operation._method === "put" || step.operation._method === "delete") {
      this.collection.items.add(
        this.generatedGetOperationItem(
          item.name,
          item.request.url.toString(),
          item.name,
          step.operation._method
        )
      );
    }
  }

  private addAsLongRunningOperationItem(item: Item, checkStatus: boolean = false) {
    this.collectionEnv.set(`${lroPollingUrl(item.name)}`, "<polling_url>", "string");
    const longRunningEvent = new Event({
      listen: "test",
      script: {
        type: "text/javascript",
        exec: `pm.environment.set("${lroPollingUrl(
          item.name
        )}", pm.response.headers.get('Location')||pm.response.headers.get('Azure-AsyncOperation')||"https://postman-echo.com/delay/10")`,
      },
    });
    item.events.add(longRunningEvent);
    this.collection.items.add(item);
    for (const it of this.longRunningOperationItem(item, checkStatus)) {
      this.collection.items.append(it);
    }
  }

  private addTestScript(
    item: Item,
    types: TestScriptType[] = ["StatusCodeAssertion"],
    overwriteVariables?: Map<string, string>,
    armTemplate?: ArmTemplate
  ) {
    if (this.opts.verbose) {
      types.push("DetailResponseLog");
    }
    if (overwriteVariables !== undefined) {
      types.push("OverwriteVariables");
    }
    // For post request do not output response log.
    if (item.request.method === "POST") {
      types = types.filter((it) => it !== "DetailResponseLog");
    }
    const testEvent = new Event({
      listen: "test",
      script: {
        type: "text/javascript",
        // generate assertion from example
        exec: this.postmanTestScript.generateScript({
          name: "response status code assertion.",
          types: types,
          variables: overwriteVariables,
          armTemplate,
        }),
      },
    });
    item.events.add(testEvent);
  }

  public async sendArmTemplateDeployment(
    armTemplate: ArmTemplate,
    params: { [name: string]: string },
    _armDeployment: ArmDeploymentTracking,
    step: TestStepArmTemplateDeployment,
    stepEnv: TestStepEnv
  ): Promise<void> {
    this.auth(stepEnv.env);
    const item = new Item();
    item.name = step.step;
    const path = `/subscriptions/:subscriptionId/resourcegroups/:resourceGroupName/providers/Microsoft.Resources/deployments/${step.step}?api-version=2020-06-01`;
    const urlVariables: VariableDefinition[] = [
      { key: "subscriptionId", value: "{{subscriptionId}}" },
      { key: "resourceGroupName", value: "{{resourceGroupName}}" },
    ];
    item.request = new Request({
      name: step.step,
      method: "put",
      url: "",
      body: { mode: "raw" } as RequestBodyDefinition,
    });
    item.request.url = new Url({
      host: this.opts.baseUrl,
      path: path,
      variable: urlVariables,
    });
    const body = {
      properties: {
        mode: "Incremental",
        template: armTemplate,
        parameters: params,
      },
    };
    for (const k of Object.keys(step.armTemplatePayload.outputs || {})) {
      stepEnv.env.set(k, `{{${k}}}`);
    }
    item.request.body = new RequestBody({
      mode: "raw",
      raw: JSON.stringify(body, null, 2),
    });
    this.addAuthorizationHeader(item);
    const scriptTypes: TestScriptType[] = this.opts.verbose
      ? ["StatusCodeAssertion", "DetailResponseLog"]
      : ["StatusCodeAssertion"];
    item.events.add(
      new Event({
        listen: "test",
        script: {
          type: "text/javascript",
          exec: this.postmanTestScript.generateScript({
            name: "response status code assertion.",
            types: scriptTypes,
            variables: undefined,
          }),
        },
      })
    );
    this.collection.items.add(item);
    this.addAsLongRunningOperationItem(item, true);
    const generatedGetScriptTypes: TestScriptType[] = this.opts.verbose
      ? ["DetailResponseLog", "ExtractARMTemplateOutput"]
      : ["ExtractARMTemplateOutput"];
    const generatedGetOperationItem = this.generatedGetOperationItem(
      item.name,
      item.request.url.toString(),
      step.step,
      "put",
      generatedGetScriptTypes,
      armTemplate
    );
    this.collection.items.add(generatedGetOperationItem);
  }

  private addAuthorizationHeader(item: Item) {
    const authorizationHeader = new Header({
      key: "Authorization",
      value: `Bearer {{bearerToken}}`,
    });
    const contentType = new Header({ key: "Content-Type", value: "application/json" });
    item.request.addHeader(contentType);
    item.request.addHeader(authorizationHeader);
  }

  private auth(env: VariableEnv) {
    if (this.collection.items.count() === 0) {
      this.collection.items.add(this.aadAuthAccessTokenItem(env));
    }
  }

  public async writeCollectionToJson(outputFolder: string) {
    const collectionPath = path.resolve(
      outputFolder,
      `${defaultCollectionFileName(
        this.opts.testScenarioFileName,
        this.opts.runId,
        this.opts.testScenarioName
      )}`
    );
    const envPath = path.resolve(
      outputFolder,
      `${defaultEnvFileName(
        this.opts.testScenarioFileName,
        this.opts.runId,
        this.opts.testScenarioName
      )}`
    );
    const env = this.collectionEnv.toJSON();
    env.name = this.opts.testScenarioFileName + "_env";
    env._postman_variable_scope = "environment";
    await this.fileLoader.writeFile(envPath, JSON.stringify(env, null, 2));
    await this.fileLoader.writeFile(
      collectionPath,
      JSON.stringify(this.collection.toJSON(), null, 2)
    );

    await this.blobUploader.uploadFile(
      "postmancollection",
      `${defaultCollectionFileName(
        this.opts.testScenarioFileName,
        this.opts.runId,
        this.opts.testScenarioName
      )}`,
      collectionPath
    );
    const values: string[] = [];
    for (const [k, v] of Object.entries(this.collectionEnv.syncVariablesTo())) {
      if (this.dataMasker.maybeSecretKey(k)) {
        values.push(v as string);
      }
    }
    this.dataMasker.addMaskedValues(values);
    await this.blobUploader.uploadContent(
      "postmancollection",
      `${defaultEnvFileName(
        this.opts.testScenarioFileName,
        this.opts.runId,
        this.opts.testScenarioName
      )}`,
      this.dataMasker.jsonStringify(env)
    );

    console.log(`\ngenerate collection successfully!`);
    console.log(`Postman collection: '${collectionPath}'. Postman env: '${envPath}' `);
    console.log(`Command: newman run ${collectionPath} -e ${envPath} -r 'json,cli'`);
  }

  public async runCollection() {
    const reportExportPath = path.resolve(
      this.opts.reportOutputFolder!,
      `${defaultNewmanReport(
        this.opts.testScenarioFileName,
        this.opts.runId,
        this.opts.testScenarioName
      )}`
    );
    const runtimeEnvManager = new RuntimeEnvManager(
      path.join(dirname(reportExportPath), this.opts.testScenarioName),
      this.opts,
      this.collection
    );

    if (this.opts.from) {
      const lastRnv = runtimeEnvManager.loadEnv(this.opts.from);
      this.collectionEnv.syncVariablesFrom(lastRnv);
      // use the variables value which exist in the env.json or process.env
      for (const k of Object.keys(this.collectionEnv.syncVariablesTo())) {
        const v = this.opts.env.get(k);
        if (v) {
          this.collectionEnv.set(k, v, typeof v);
        }
      }
    }
    if (this.opts.from || this.opts.to) {
      runtimeEnvManager.repopulateCollectionItems(this.opts.from, this.opts.to);
    }
    const newmanRun = async () => {
      return new Promise((resolve) => {
        newman
          .run(
            {
              collection: this.collection,
              environment: this.collectionEnv,
              reporters: ["cli", "json"],
              reporter: { json: { export: reportExportPath } },
            },
            function (err, summary) {
              if (summary.run.failures.length > 0) {
                process.exitCode = 1;
              }
              if (err) {
                console.log(`collection run failed. ${err}`);
              }
              console.log("collection run complete!");
            }
          )
          .on("beforeItem", async function (this: any, _err, _summary) {
            if (!_err) {
              runtimeEnvManager.save(_summary.item.name, this, "beforeStep");
            }
          })
          .on("item", async function (this: any, _err, _summary) {
            if (!_err) {
              runtimeEnvManager.clean();
              runtimeEnvManager.save(_summary.item.name, this, "afterStep");
            }
          })
          .on("done", async (_err, _summary) => {
            const keys = await this.swaggerAnalyzer.getAllSecretKey();
            const values: string[] = [];
            for (const [k, v] of Object.entries(this.collectionEnv.syncVariablesTo())) {
              if (this.dataMasker.maybeSecretKey(k)) {
                values.push(v as string);
              }
            }
            this.dataMasker.addMaskedValues(values);
            this.dataMasker.addMaskedKeys(keys);
            // read content and upload. mask newman report.
            const newmanReport = JSON.parse(
              await this.fileLoader.load(reportExportPath)
            ) as NewmanReport;

            // add mask environment secret value
            for (const item of newmanReport.environment.values) {
              if (this.dataMasker.maybeSecretKey(item.key)) {
                this.dataMasker.addMaskedValues([item.value]);
              }
            }
            if (this.opts.enableBlobUploader) {
              await this.blobUploader.uploadContent(
                "newmanreport",
                `${defaultNewmanReport(
                  this.opts.testScenarioFileName,
                  this.opts.runId,
                  this.opts.testScenarioName
                )}`,
                this.dataMasker.jsonStringify(newmanReport)
              );
            }
            const opts: NewmanReportAnalyzerOption = {
              newmanReportFilePath: reportExportPath,
              markdownReportPath: this.opts.markdownReportPath,
              junitReportPath: this.opts.junitReportPath,
              enableUploadBlob: this.opts.enableBlobUploader,
              runId: this.opts.runId,
              swaggerFilePaths: this.opts.swaggerFilePaths,
              validationLevel: this.opts.validationLevel,
              verbose: this.opts.verbose,
            };
            const reportAnalyzer = inversifyGetInstance(NewmanReportAnalyzer, opts);
            await reportAnalyzer.analyze();
            if (this.opts.skipCleanUp || this.opts.to) {
              printWarning(
                `Notice:the resource group '${this.collectionEnv.get(
                  "resourceGroupName"
                )}' was not cleaned up.`
              );
            }
            resolve(_summary);
          });
      });
    };
    await newmanRun();
  }

  private generatedGetOperationItem(
    name: string,
    url: string,
    step: string,
    prevMethod: string = "put",
    scriptTypes: TestScriptType[] = [],
    armTemplate?: ArmTemplate
  ): Item {
    const item = new Item({
      name: `${generatedPostmanItem(generatedGet(name))}`,
      request: {
        method: "get",
        url: url,
      },
    });
    item.description = typeToDescription({
      type: "generated-get",
      lro_item_name: name,
      step: step,
    });
    this.addAuthorizationHeader(item);
    if (prevMethod !== "delete") {
      scriptTypes.push("StatusCodeAssertion");
    }
    this.addTestScript(item, scriptTypes, undefined, armTemplate);
    return item;
  }

  public longRunningOperationItem(initialItem: Item, checkStatus: boolean = false): Item[] {
    const ret: Item[] = [];
    const pollerItemName = generatedPostmanItem(initialItem.name + "_poller");
    const pollerItem = new Item({
      name: pollerItemName,
      request: {
        url: `{{${lroPollingUrl(initialItem.name)}}}`,
        method: "get",
        header: [{ key: "Authorization", value: "Bearer {{bearerToken}}" }],
      },
    });
    pollerItem.description = typeToDescription({ type: "poller", lro_item_name: initialItem.name });
    const delay = this.mockDelayItem(pollerItem.name, initialItem.name);
    const event = new Event({
      listen: "test",
      script: {
        type: "text/javascript",
        exec: `
      try{
        if(pm.response.code===202){
          postman.setNextRequest('${delay.name}')
        }else if(pm.response.code==204){
          postman.setNextRequest($(nextRequest))
        }
        else{
          const terminalStatus = ["Succeeded", "Failed", "Canceled"]
          if(pm.response.json().status!==undefined&&terminalStatus.indexOf(pm.response.json().status)===-1){
            postman.setNextRequest('${delay.name}')
          }else{
            postman.setNextRequest($(nextRequest))
          }
        }
      }catch(err){
        postman.setNextRequest($(nextRequest))
      }`,
      },
    });

    pollerItem.events.add(event);
    if (checkStatus) {
      const checkStatusEvent = new Event({
        listen: "test",
        script: {
          type: "text/javascript",
          exec: this.postmanTestScript.generateScript({
            name: "armTemplate deployment status check",
            types: ["StatusCodeAssertion", "ARMDeploymentStatusAssertion"],
          }),
        },
      });
      pollerItem.events.add(checkStatusEvent);
    }

    ret.push(pollerItem);
    ret.push(delay);
    return ret;
  }

  public mockDelayItem(nextRequestName: string, LROItemName: string): Item {
    const ret = new Item({
      name: `${nextRequestName}_mock_delay`,
      request: {
        url: "https://postman-echo.com/delay/10",
        method: "get",
      },
    });

    ret.description = typeToDescription({ type: "mock", lro_item_name: LROItemName });
    const event = new Event({
      listen: "prerequest",
      script: {
        type: "text/javascript",
        exec: `postman.setNextRequest('${nextRequestName}')`,
      },
    });
    ret.events.add(event);
    return ret;
  }

  public aadAuthAccessTokenItem(env: VariableEnv): Item {
    const urlVariables: VariableDefinition[] = [{ key: "tenantId", value: "{{tenantId}}" }];
    const ret = new Item({
      name: "get Azure AAD Token",
    } as ItemDefinition);
    ret.request = new Request({
      method: "post",
      url: "",
      body: {
        mode: "urlencoded",
        urlencoded: [
          { key: "grant_type", value: "client_credentials" },
          { key: "client_id", value: "{{client_id}}" },
          { key: "client_secret", value: "{{client_secret}}" },
          { key: "resource", value: "https://management.azure.com" },
        ] as QueryParamDefinition[],
      },
    });
    ret.request.url = new Url({
      path: "/:tenantId/oauth2/token",
      host: "https://login.microsoftonline.com",
      variable: urlVariables,
    } as UrlDefinition);
    this.collectionEnv.set("tenantId", env.get("tenantId"), "string");
    this.collectionEnv.set("client_id", env.get("client_id"), "string");
    this.collectionEnv.set("client_secret", env.get("client_secret"), "string");
    this.collectionEnv.set("resourceGroupName", env.get("resourceGroupName"), "string");
    this.collectionEnv.set("subscriptionId", env.get("subscriptionId"), "string");
    ret.events.add(
      new Event({
        listen: "test",
        script: {
          type: "text/javascript",
          exec: this.postmanTestScript.generateScript({
            name: "AAD auth should be successful",
            types: ["ResponseDataAssertion", "OverwriteVariables"],
            variables: new Map<string, string>([["bearerToken", "/access_token"]]),
          }),
        },
      })
    );
    return ret;
  }
}
