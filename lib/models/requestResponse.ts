/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for
 * license information.
 *
 * Code generated by Microsoft (R) AutoRest Code Generator.
 * Changes may cause incorrect behavior and will be lost if the code is
 * regenerated.
 */

/**
 * @class
 * Initializes a new instance of the RequestResponse class.
 * @constructor
 * Describes the live request and response to be validated.
 *
 * @member {object} liveRequest Schema for the live request to be validated
 *
 * @member {object} [liveRequest.headers] Headers of the request.
 *
 * @member {string} [liveRequest.method] Http verb of the request. Possible
 * values include: 'GET', 'PUT', 'PATCH', 'POST', 'DELETE', 'HEAD', 'OPTIONS',
 * 'TRACE'
 *
 * @member {string} [liveRequest.url] Url of the request.
 *
 * @member {object} [liveRequest.body] Parsed body of the request as a JSON.
 *
 * @member {object} liveResponse Schema for the live response to be validated
 *
 * @member {string} [liveResponse.statusCode] The Response status code.
 *
 * @member {object} [liveResponse.headers] Headers of the response.
 *
 * @member {object} [liveResponse.body] Body of the response.
 *
 * @member {string} [liveResponse.encoding] The encoding of the response body
 * when the body is a buffer.
 *
 */
export class RequestResponse {
  /**
   * Defines the metadata of RequestResponse
   *
   * @returns {object} metadata of RequestResponse
   *
   */
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  public mapper() {
    return {
      required: false,
      serializedName: "RequestResponse",
      type: {
        name: "Composite",
        className: "RequestResponse",
        modelProperties: {
          liveRequest: {
            required: true,
            serializedName: "liveRequest",
            type: {
              name: "Composite",
              className: "LiveRequest",
            },
          },
          liveResponse: {
            required: true,
            serializedName: "liveResponse",
            type: {
              name: "Composite",
              className: "LiveResponse",
            },
          },
        },
      },
    };
  }
}
