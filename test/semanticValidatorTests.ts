// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import assert from "assert";
import * as constants from "../lib/util/constants";
import * as validate from "../lib/validate";

const testPath = __dirname;

describe("Semantic validation", () => {
  it("should validate correctly when the spec contains an x-ms-parameterized-host", async () => {
    const specPath = `${testPath}/semanticValidation/specification/parameterizedhost/face.json`;
    const result = await validate.validateSpec(specPath, undefined);
    // console.dir(result, { depth: null })
    assert(
      result.validityStatus === true,
      `swagger "${specPath}" contains semantic validation errors.`
    );
  });

  it("should validate correctly when the spec does not contain a definitions section", async () => {
    const specPath = `${testPath}/semanticValidation/specification/definitions/definitions.json`;
    const result = await validate.validateSpec(specPath, undefined);
    // console.dir(result, { depth: null })
    assert(
      result.validityStatus === true,
      `swagger "${specPath}" contains semantic validation errors.`
    );
  });

  it("should fail when validating a swagger with JSON errors", async () => {
    const specPath = `${testPath}/semanticValidation/specification/invalid/invalid.json`;
    const result = await validate.validateSpec(specPath, undefined);
    assert(result.validityStatus === false);
    assert.strictEqual(
      result.validateSpec?.errors?.[0].code,
      constants.ErrorCodes.JsonParsingError.name
    );
  });

  it("should fail when discriminator is not a required property", async () => {
    const specPath = `${testPath}/semanticValidation/specification/invalid/notRequiredDiscriminator.json`;
    const result = await validate.validateSpec(specPath, undefined);
    assert(result.validityStatus === false);
  });

  it("should succeed when discriminator is not a required property and the error is suppressed", async () => {
    const specPath = `${testPath}/semanticValidation/specification/invalid/notRequiredDiscriminatorWithSuppression.json`;
    const result = await validate.validateSpec(specPath, undefined);
    assert(result.validityStatus === true);
  });

  it("should fail when validating a swagger with invalid internal reference", async () => {
    const specPath = `${testPath}/semanticValidation/specification/invalidReference/searchindex.json`;
    const result = await validate.validateSpec(specPath, undefined);
    assert(result.validityStatus === false);
  });
});
