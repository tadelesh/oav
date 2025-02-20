// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import assert from "assert";
import { getProviderFromPathTemplate } from "../lib/liveValidation/operationSearcher";

describe("Utility functions", () => {
  describe("Get Provider", () => {
    it("should throw on empty", () => {
      assert.throws(() => {
        getProviderFromPathTemplate("");
      });
    });
    it("should throw null", () => {
      assert.throws(() => {
        getProviderFromPathTemplate(null);
      });
    });
    it("should throw undefined", () => {
      assert.throws(() => {
        getProviderFromPathTemplate();
      });
    });
    it("should return Microsoft.Resources", () => {
      const path =
        "/subscriptions/{subscriptionId}/resourcegroups/{resourceGroupName}/providers/" +
        "Microsoft.Resources/{parentResourcePath}/{resourceType}/{resourceName}";
      const provider = getProviderFromPathTemplate(path);
      assert.strictEqual(provider, "Microsoft.Resources");
    });
    it("should return undefined", () => {
      const path = "/subscriptions/{subscriptionId}/resourcegroups/{resourceGroupName}/providers/";
      const provider = getProviderFromPathTemplate(path);
      assert.strictEqual(provider, undefined);
    });
    it("should return Microsoft.Authorization", () => {
      const path =
        "/subscriptions/{subscriptionId}/resourcegroups/{resourceGroupName}/providers/" +
        "Microsoft.Resources/{parentResourcePath}/{resourceType}/{resourceName}/providers/" +
        "Microsoft.Authorization/roleAssignments";
      const provider = getProviderFromPathTemplate(path);
      assert.strictEqual(provider, "Microsoft.Authorization");
    });
  });
});
