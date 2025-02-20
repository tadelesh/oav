/* eslint-disable require-atomic-updates */
import * as fs from "fs";

import { join as pathJoin, dirname, resolve as pathResolve } from "path";
import { dump as yamlDump, load as yamlLoad } from "js-yaml";
import { default as AjvInit, ValidateFunction } from "ajv";
import { inject, injectable } from "inversify";
import { cloneDeep } from "@azure-tools/openapi-tools-common";
import { JSONPath } from "jsonpath-plus";
import { Loader, setDefaultOpts } from "../swagger/loader";
import { FileLoader, FileLoaderOption } from "../swagger/fileLoader";
import { JsonLoader, JsonLoaderOption } from "../swagger/jsonLoader";
import { getTransformContext, TransformContext } from "../transform/context";
import { SchemaValidator } from "../swaggerValidator/schemaValidator";
import { xmsPathsTransformer } from "../transform/xmsPathsTransformer";
import { resolveNestedDefinitionTransformer } from "../transform/resolveNestedDefinitionTransformer";
import { referenceFieldsTransformer } from "../transform/referenceFieldsTransformer";
import { discriminatorTransformer } from "../transform/discriminatorTransformer";
import { allOfTransformer } from "../transform/allOfTransformer";
import { noAdditionalPropertiesTransformer } from "../transform/noAdditionalPropertiesTransformer";
import { nullableTransformer } from "../transform/nullableTransformer";
import { pureObjectTransformer } from "../transform/pureObjectTransformer";
import { SwaggerLoader, SwaggerLoaderOption } from "../swagger/swaggerLoader";
import { applySpecTransformers, applyGlobalTransformers } from "../transform/transformer";
import { SwaggerSpec, Operation, SwaggerExample } from "../swagger/swaggerTypes";
import { traverseSwagger } from "../transform/traverseSwagger";
import { inversifyGetInstance, TYPES } from "../inversifyUtils";
import { getProvider } from "../util/utils";
import {
  TestDefinitionSchema,
  TestDefinitionFile,
  TestScenario,
  TestStep,
  TestStepRestCall,
  TestStepArmTemplateDeployment,
  RawTestDefinitionFile,
  RawTestStepArmTemplateDeployment,
  RawTestStep,
  RawTestStepRestCall,
  RawTestScenario,
  RawTestStepRawCall,
  TestStepRawCall,
} from "./testResourceTypes";
import { ExampleTemplateGenerator } from "./exampleTemplateGenerator";
import { BodyTransformer } from "./bodyTransformer";
import { jsonPatchApply } from "./diffUtils";
import { getResourceFromPath, getResourceTypePath } from "./swaggerAnalyzer";

const ajv = new AjvInit({
  useDefaults: true,
});

export interface TestResourceLoaderOption
  extends FileLoaderOption,
    JsonLoaderOption,
    SwaggerLoaderOption {
  swaggerFilePaths?: string[];
}

interface TestScenarioContext {
  stepTracking: Map<string, TestStep>;
  resourceTracking: Map<string, TestStep>;
  testDef: TestDefinitionFile;
  testScenario?: TestScenario;
}

@injectable()
export class TestResourceLoader implements Loader<TestDefinitionFile> {
  private transformContext: TransformContext;
  private validateTestResourceFile: ValidateFunction;
  private exampleToOperation = new Map<string, { [operationId: string]: [Operation, string] }>();
  private nameToOperation: Map<string, Operation> = new Map();
  private initialized: boolean = false;

  public constructor(
    @inject(TYPES.opts) private opts: TestResourceLoaderOption,
    private fileLoader: FileLoader,
    public jsonLoader: JsonLoader,
    private swaggerLoader: SwaggerLoader,
    private exampleTemplateGenerator: ExampleTemplateGenerator,
    private bodyTransformer: BodyTransformer,
    @inject(TYPES.schemaValidator) private schemaValidator: SchemaValidator
  ) {
    setDefaultOpts(opts, {
      swaggerFilePaths: [],
    });

    this.transformContext = getTransformContext(this.jsonLoader, this.schemaValidator, [
      xmsPathsTransformer,
      resolveNestedDefinitionTransformer,
      referenceFieldsTransformer,

      discriminatorTransformer,
      allOfTransformer,
      noAdditionalPropertiesTransformer,
      nullableTransformer,
      pureObjectTransformer,
    ]);

    this.validateTestResourceFile = ajv.compile(TestDefinitionSchema);
  }

  public static create(opts: TestResourceLoaderOption) {
    setDefaultOpts(opts, {
      eraseXmsExamples: false,
      eraseDescription: false,
      skipResolveRefKeys: ["x-ms-examples"],
    });
    return inversifyGetInstance(TestResourceLoader, opts);
  }

  public async initialize() {
    if (this.initialized) {
      throw new Error("Already initialized");
    }

    const allSpecs: SwaggerSpec[] = [];
    for (const swaggerFilePath of this.opts.swaggerFilePaths ?? []) {
      const swaggerSpec = await this.swaggerLoader.load(swaggerFilePath);
      allSpecs.push(swaggerSpec);
      applySpecTransformers(swaggerSpec, this.transformContext);
    }
    applyGlobalTransformers(this.transformContext);

    for (const spec of allSpecs) {
      traverseSwagger(spec, {
        onOperation: (operation) => {
          if (operation.operationId === undefined) {
            throw new Error(
              `OperationId is undefined for operation ${operation._method} ${operation._path._pathTemplate}`
            );
          }

          if (this.nameToOperation.has(operation.operationId)) {
            throw new Error(
              `Duplicated operationId ${operation.operationId}: ${
                operation._path._pathTemplate
              }\nConflict with path: ${
                this.nameToOperation.get(operation.operationId)?._path._pathTemplate
              }`
            );
          }
          this.nameToOperation.set(operation.operationId, operation);

          const xMsExamples = operation["x-ms-examples"] ?? {};
          for (const exampleName of Object.keys(xMsExamples)) {
            const example = xMsExamples[exampleName];
            if (typeof example.$ref !== "string") {
              throw new Error(`Example doesn't use $ref: ${exampleName}`);
            }
            const exampleFilePath = this.jsonLoader.getRealPath(example.$ref);
            let opMap = this.exampleToOperation.get(exampleFilePath);
            if (opMap === undefined) {
              opMap = {};
              this.exampleToOperation.set(exampleFilePath, opMap);
            }
            opMap[operation.operationId] = [operation, exampleName];
          }
        },
      });
    }

    this.initialized = true;
  }

  public async writeTestDefinitionFile(filePath: string, testDef: RawTestDefinitionFile) {
    const fileContent = yamlDump(testDef);
    return this.fileLoader.writeFile(filePath, fileContent);
  }

  public async load(filePath: string): Promise<TestDefinitionFile> {
    if (!this.initialized) {
      await this.initialize();
    }

    const fileContent = await this.fileLoader.load(filePath);
    const filePayload = yamlLoad(fileContent);
    if (!this.validateTestResourceFile(filePayload)) {
      const err = this.validateTestResourceFile.errors![0];
      throw new Error(
        `Failed to validate test resource file ${filePath}: ${err.dataPath} ${err.message}`
      );
    }
    const rawTestDef = filePayload as RawTestDefinitionFile;
    const testDef: TestDefinitionFile = {
      scope: rawTestDef.scope ?? "ResourceGroup",
      requiredVariables: rawTestDef.requiredVariables ?? [],
      prepareSteps: [],
      testScenarios: [],
      _filePath: this.fileLoader.relativePath(filePath),
      variables: rawTestDef.variables ?? {},
    };

    if (testDef.scope === "ResourceGroup") {
      const requiredVariables = new Set(testDef.requiredVariables);
      requiredVariables.add("subscriptionId");
      requiredVariables.add("location");
      testDef.requiredVariables = [...requiredVariables];
    }

    const ctx: TestScenarioContext = {
      stepTracking: new Map(),
      resourceTracking: new Map(),
      testDef,
    };
    for (const rawStep of rawTestDef.prepareSteps ?? []) {
      const step = await this.loadTestStep(rawStep, ctx);
      step.isScopePrepareStep = true;
      testDef.prepareSteps.push(step);
    }

    for (const rawTestScenario of rawTestDef.testScenarios) {
      const testScenario = await this.loadTestScenario(rawTestScenario, ctx);
      testDef.testScenarios.push(testScenario);
    }

    return testDef;
  }

  private async loadTestScenario(
    rawTestScenario: RawTestScenario,
    ctx: TestScenarioContext
  ): Promise<TestScenario> {
    const resolvedSteps: TestStep[] = [];
    const steps: TestStep[] = [];
    const { testDef } = ctx;

    const requiredVariables = new Set([
      ...(rawTestScenario.requiredVariables ?? []),
      ...testDef.requiredVariables,
    ]);

    for (const step of testDef.prepareSteps) {
      resolvedSteps.push(step);
    }

    const testScenario: TestScenario = {
      description: rawTestScenario.description,
      shareTestScope: rawTestScenario.shareTestScope ?? true,
      variables: rawTestScenario.variables ?? {},
      requiredVariables: [...requiredVariables],
      steps,
      _resolvedSteps: resolvedSteps,
      _testDef: testDef,
    };
    ctx.testScenario = testScenario;

    for (const rawStep of rawTestScenario.steps) {
      const step = await this.loadTestStep(rawStep, ctx);
      resolvedSteps.push(step);
      steps.push(step);
    }

    await this.exampleTemplateGenerator.generateExampleTemplateForTestScenario(testScenario);

    return testScenario;
  }

  private async loadTestStep(step: RawTestStep, ctx: TestScenarioContext): Promise<TestStep> {
    if ("armTemplateDeployment" in step) {
      return this.loadTestStepArmTemplate(step, ctx);
    } else if ("exampleFile" in step || "resourceName" in step || "operationId" in step) {
      return this.loadTestStepRestCall(step, ctx);
    } else if ("rawUrl" in step) {
      return this.loadTestStepRawCall(step, ctx);
    } else {
      throw new Error(`Unknown step type: ${JSON.stringify(step)}`);
    }
  }

  private async loadTestStepRawCall(rawStep: RawTestStepRawCall, _ctx: TestScenarioContext) {
    const step: TestStepRawCall = {
      type: "rawCall",
      variables: rawStep.variables ?? {},
      statusCode: rawStep.statusCode ?? 200,
      ...rawStep,
    };
    return step;
  }

  private async loadTestStepArmTemplate(
    rawStep: RawTestStepArmTemplateDeployment,
    ctx: TestScenarioContext
  ): Promise<TestStepArmTemplateDeployment> {
    const step: TestStepArmTemplateDeployment = {
      type: "armTemplateDeployment",
      variables: rawStep.variables ?? {},
      step: rawStep.step ?? "__step_with_no_name",
      armTemplateDeployment: rawStep.armTemplateDeployment,
      armTemplatePayload: {},
    };
    const { testDef, testScenario } = ctx;

    const filePath = pathJoin(dirname(testDef._filePath), step.armTemplateDeployment);
    const armTemplateContent = await this.fileLoader.load(filePath);
    step.armTemplatePayload = JSON.parse(armTemplateContent);

    const definedParameters = [];
    if (rawStep.armTemplateParameters !== undefined) {
      const armTemplateParametersPath = pathJoin(
        dirname(testDef._filePath),
        rawStep.armTemplateParameters
      );
      const armTemplateParametersContent = await this.fileLoader.load(armTemplateParametersPath);
      step.armTemplateParametersPayload = JSON.parse(armTemplateParametersContent);
      definedParameters.push(...Object.keys(step.armTemplateParametersPayload!.parameters));
    }
    const definedParameterSet = new Set(definedParameters);

    const params = step.armTemplatePayload.parameters;
    if (params !== undefined) {
      for (const paramName of Object.keys(params)) {
        if (definedParameterSet.has(paramName) || params[paramName].defaultValue !== undefined) {
          continue;
        }
        if (params[paramName].type !== "string") {
          throw new Error(
            `Only string type is supported in arm template params, please specify defaultValue or add it in arm template parameter file with armTemplateParameters: ${paramName}`
          );
        }
        if (testScenario !== undefined) {
          testScenario.requiredVariables.push(paramName);
        } else {
          testDef.requiredVariables.push(paramName);
        }
      }
    }

    return step;
  }

  private async loadTestStepRestCall(
    rawStep: RawTestStepRestCall,
    ctx: TestScenarioContext
  ): Promise<TestStepRestCall> {
    if (rawStep.step === undefined) {
      throw new Error(
        `Property "step" as step name is required for restCall step: ${rawStep.exampleFile}`
      );
    }
    if (ctx.resourceTracking.has(rawStep.step)) {
      throw new Error(`Duplicated step name: ${rawStep.step}`);
    }

    const step: TestStepRestCall = {
      type: "restCall",
      step: rawStep.step!,
      resourceName: rawStep.resourceName,
      exampleFile: rawStep.exampleFile,
      variables: rawStep.variables ?? {},
      operationId: rawStep.operationId ?? "",
      operation: {} as Operation,
      requestParameters: {} as SwaggerExample["parameters"],
      responseExpected: {},
      exampleId: "",
      resourceType: "",
      statusCode: rawStep.statusCode ?? 200,
      outputVariables: rawStep.outputVariables ?? {},
      resourceUpdate: rawStep.resourceUpdate ?? [],
      requestUpdate: rawStep.requestUpdate ?? [],
      responseUpdate: rawStep.responseUpdate ?? [],
    };

    if (rawStep.operationId !== undefined) {
      const operation = this.nameToOperation.get(rawStep.operationId);
      if (operation === undefined) {
        throw new Error(`Operation not found for ${rawStep.operationId}`);
      }
      step.operation = operation;
    }

    if (step.exampleFile !== undefined) {
      await this.loadTestStepRestCallExampleFile(step, ctx);
    } else {
      await this.loadTestStepRestCallFromStep(step, ctx);
    }

    if (step.resourceUpdate.length > 0) {
      let target = cloneDeep(step.responseExpected);
      const bodyParamName = getBodyParamName(step.operation, this.jsonLoader);
      if (bodyParamName !== undefined) {
        try {
          this.bodyTransformer.deepMerge(target, step.requestParameters[bodyParamName]);
        } catch (err) {
          console.log("err");
          console.log(err);
        }
      }
      target = jsonPatchApply(target, step.resourceUpdate);

      if (bodyParamName !== undefined) {
        const convertedRequest = await this.bodyTransformer.responseBodyToRequest(
          target,
          step.operation.responses[step.statusCode].schema!
        );
        step.requestParameters[bodyParamName] = convertedRequest;
      }

      step.responseExpected = await this.bodyTransformer.requestBodyToResponse(
        target,
        step.operation.responses[step.statusCode].schema!
      );
    }

    if (step.requestUpdate.length > 0) {
      step.requestParameters = jsonPatchApply(
        cloneDeep(step.requestParameters),
        step.requestUpdate
      );
    }
    if (step.responseUpdate.length > 0) {
      step.responseExpected = jsonPatchApply(cloneDeep(step.responseExpected), step.responseUpdate);
    }

    ctx.stepTracking.set(step.step, step);
    if (step.resourceName !== undefined) {
      ctx.resourceTracking.set(step.resourceName, step);
    }

    return step;
  }

  private async loadTestStepRestCallFromStep(step: TestStepRestCall, ctx: TestScenarioContext) {
    if (step.operation._method !== "put") {
      throw new Error(`resourceUpdate could only be used with "PUT" operation`);
    }
    const lastStep = ctx.resourceTracking.get(step.resourceName!);
    if (lastStep === undefined) {
      throw new Error(`Unknown resourceName: ${step.resourceName}`);
    }
    if (lastStep.type !== "restCall") {
      throw new Error(
        `Cannot use resourceName from non restCall type for step: ${step.resourceName}`
      );
    }

    step.requestParameters = { ...lastStep.requestParameters };
    step.responseExpected = lastStep.responseExpected;
    step.exampleId = lastStep.exampleId;
    if (step.operationId === "") {
      step.operationId = lastStep.operationId;
      step.operation = lastStep.operation;
    }
  }

  private async loadTestStepRestCallExampleFile(step: TestStepRestCall, ctx: TestScenarioContext) {
    const filePath = step.exampleFile;
    if (filePath === undefined) {
      throw new Error(`RestCall step must specify "exampleFile" or "fromStep"`);
    }

    const exampleFilePath = pathJoin(dirname(ctx.testDef._filePath), filePath);

    // Load example file
    const fileContent = await this.fileLoader.load(exampleFilePath);
    const exampleFileContent = JSON.parse(fileContent) as SwaggerExample;

    step.requestParameters = exampleFileContent.parameters;
    step.responseExpected = exampleFileContent.responses[step.statusCode]?.body;

    // Load Operation
    if (step.operationId === "") {
      const opMap = this.exampleToOperation.get(exampleFilePath);
      if (opMap === undefined) {
        throw new Error(`Example file is not referenced by any operation: ${filePath}`);
      }
      const ops = Object.values(opMap);
      if (ops.length > 1) {
        throw new Error(
          `Example file is referenced by multiple operation: ${Object.keys(opMap)} ${filePath}`
        );
      }
      [step.operation, step.exampleId] = ops[0];
      step.operationId = step.operation.operationId!;
    }

    // Load resource type
    const resourceChain = getResourceFromPath(step.operation._path._pathTemplate);
    const resourceProvider = getProvider(step.operation._path._pathTemplate)!;
    const resourceType = getResourceTypePath(resourceChain, resourceProvider);
    step.resourceType = resourceType;
  }
}

export const getBodyParamName = (operation: Operation, jsonLoader: JsonLoader) => {
  const bodyParams = operation.parameters?.find((param) => {
    const resolvedObj = jsonLoader.resolveRefObj(param);
    return resolvedObj.in === "body";
  });
  return bodyParams?.name;
};

const getAllSwaggerFilePathUnderDir = (dir: string): any[] => {
  const allSwaggerFiles = fs
    .readdirSync(dir)
    .map((it) => pathResolve(dir, it))
    .filter((it) => it.endsWith(".json"));
  return allSwaggerFiles;
};

export const getSwaggerFilePathsFromTestScenarioFilePath = (
  testScenarioFilePath: string
): string[] => {
  const fileContent = fs.readFileSync(testScenarioFilePath).toString();
  const testDef = yamlLoad(fileContent) as RawTestDefinitionFile;
  const allSwaggerFilePaths = getAllSwaggerFilePathUnderDir(dirname(dirname(testScenarioFilePath)));
  const allSwaggerFiles = allSwaggerFilePaths.map((it) => {
    return {
      swaggerFilePath: it,
      swaggerObj: JSON.parse(fs.readFileSync(it).toString()),
    };
  });
  const findMatchedSwagger = (exampleFileName: string): string | undefined => {
    for (const it of allSwaggerFiles) {
      const allXmsExamplesPath = "$..x-ms-examples..$ref";
      const allXmsExampleValues = JSONPath({
        path: allXmsExamplesPath,
        json: it.swaggerObj,
        resultType: "all",
      });
      if (allXmsExampleValues.some((it: any) => it.value.includes(exampleFileName))) {
        return it.swaggerFilePath;
      }
    }
    return undefined;
  };
  const res: Set<string> = new Set<string>();

  for (const step of testDef.prepareSteps ?? []) {
    const restCall = step as RawTestStepRestCall;
    if (restCall !== undefined && restCall.exampleFile !== undefined) {
      const swaggerFilePath = findMatchedSwagger(restCall.exampleFile.replace(/^.*[\\\/]/, ""));
      if (swaggerFilePath !== undefined) {
        res.add(swaggerFilePath);
      }
    }
  }

  for (const testScenario of testDef.testScenarios ?? []) {
    for (const step of testScenario.steps) {
      const restCall = step as RawTestStepRestCall;
      if (restCall !== undefined && restCall.exampleFile !== undefined) {
        const swaggerFilePath = findMatchedSwagger(restCall.exampleFile.replace(/^.*[\\\/]/, ""));
        if (swaggerFilePath !== undefined) {
          res.add(swaggerFilePath);
        }
      }
    }
  }
  return Array.from(res.values());
};
