import { ArmTemplate } from "./testResourceTypes";

interface ScriptTemplate {
  text: string;
}

const StatusCodeAssertion: ScriptTemplate = {
  text: `pm.expect(pm.response.code).to.be.oneOf([200, 201, 202, 204]);`,
};

const ARMDeploymentStatusAssertion: ScriptTemplate = {
  text: `pm.expect(pm.response.json().status).to.be.oneOf(["Succeeded", "Accepted", "Running", "Ready", "Creating", "Created", "Deleting", "Deleted", "Canceled", "Updating"]);`,
};

const DetailResponseLog: ScriptTemplate = {
  text: `
  console.log(pm.response.text());
  `,
};

const GetObjectValueByJsonPointer: ScriptTemplate = {
  text: `
  const getValueByJsonPointer = (obj, pointer) => {
    var refTokens = Array.isArray(pointer) ? pointer : parse(pointer);

    for (var i = 0; i < refTokens.length; ++i) {
        var tok = refTokens[i];
        if (!(typeof obj == 'object' && tok in obj)) {
            throw new Error('Invalid reference token: ' + tok);
        }
        obj = obj[tok];
    }
    return obj;
  };

  const jsonPointerUnescape = (str)=>{
    return str.replace(/~1/g, '/').replace(/~0/g, '~');
  };

  const parse = (pointer) => {
    if (pointer === "") {
      return [];
    }
    if (pointer.charAt(0) !== "/") {
      throw new Error("Invalid JSON pointer: " + pointer);
    }
    return pointer.substring(1).split(/\\//).map(jsonPointerUnescape);
  };


  `,
};

interface TestScriptParameter {
  name: string;
  types: TestScriptType[];
  variables?: Map<string, string>;
  armTemplate?: ArmTemplate;
}

export type TestScriptType =
  | "StatusCodeAssertion"
  | "ResponseDataAssertion"
  | "DetailResponseLog"
  | "OverwriteVariables"
  | "ARMDeploymentStatusAssertion"
  | "ExtractARMTemplateOutput";

export class PostmanTestScript {
  // eslint-disable-next-line @typescript-eslint/explicit-member-accessibility
  constructor() {}

  public generateScript(parameter: TestScriptParameter): string {
    const begin = `pm.test("${parameter.name}", function() {`;
    const end = "});";
    let ret = begin;
    if (parameter.types.includes("DetailResponseLog")) {
      ret += DetailResponseLog.text;
    }
    if (parameter.types.includes("StatusCodeAssertion")) {
      ret += StatusCodeAssertion.text;
    }
    if (parameter.types.includes("OverwriteVariables")) {
      ret += this.generateOverWriteVariablesScript(parameter.variables!);
    }
    if (parameter.types.includes("ARMDeploymentStatusAssertion")) {
      ret += ARMDeploymentStatusAssertion.text;
    }
    if (parameter.types.includes("ExtractARMTemplateOutput")) {
      ret += this.generateARMTemplateOutputScript(parameter.armTemplate!);
    }
    return ret + end;
  }

  private generateOverWriteVariablesScript(variables: Map<string, string>): string {
    let ret = GetObjectValueByJsonPointer.text;
    for (const [k, v] of variables) {
      ret += `pm.environment.set("${k}", getValueByJsonPointer(pm.response.json(), "${v}"));`;
    }
    return ret;
  }

  private generateARMTemplateOutputScript(armTemplate: ArmTemplate): string {
    let ret = "";
    for (const key of Object.keys(armTemplate.outputs || {})) {
      ret += `pm.environment.set("${key}", pm.response.json().properties.outputs.${key}.value);`;
    }
    return ret;
  }
}
