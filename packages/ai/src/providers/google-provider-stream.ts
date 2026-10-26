import type { GenerateContentParameters } from "@google/genai";
import { createAssistantOutput } from "../transports/assistant-output.js";
import {
  failTransportStream,
  notifyProviderStreamOpened,
  transportAbortError,
} from "../transports/transport-stream-shared.js";
import type { Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  buildGoogleGenerateContentParams,
  buildGoogleSimpleThinking,
  type GoogleGenerateContentClient,
  type GoogleProviderOptions,
} from "./google-shared.js";
import { consumeGoogleGenerateContentStream } from "./google-stream.js";
import { buildBaseOptions } from "./simple-options.js";

export function createGoogleGenerateContentStreams<
  T extends "google-generative-ai" | "google-vertex",
>(
  api: T,
  createClient: (model: Model<T>, options?: GoogleProviderOptions) => GoogleGenerateContentClient,
  resolveSimpleApiKey?: (model: Model<T>, options?: SimpleStreamOptions) => string,
): {
  stream: StreamFunction<T, GoogleProviderOptions>;
  streamSimple: StreamFunction<T, SimpleStreamOptions>;
} {
  let toolCallCounter = 0;
  const stream: StreamFunction<T, GoogleProviderOptions> = (model, context, options) => {
    const events = new AssistantMessageEventStream();
    const output = createAssistantOutput(model, api);
    void (async () => {
      try {
        const client = createClient(model, options);
        let requestParams: GenerateContentParameters = buildGoogleGenerateContentParams(
          model,
          context,
          options,
        );
        const nextParams = await options?.onPayload?.(requestParams, model);
        if (nextParams !== undefined) {
          requestParams = nextParams as GenerateContentParameters;
        }
        const googleStream = await client.models.generateContentStream(requestParams);
        const googleIterator = googleStream[Symbol.asyncIterator]();
        await notifyProviderStreamOpened({
          options,
          cancelStream: async () => {
            await googleIterator.return?.();
          },
        });
        await consumeGoogleGenerateContentStream({
          chunks: { [Symbol.asyncIterator]: () => googleIterator },
          model,
          output,
          stream: events,
          signal: options?.signal,
          nextToolCallId: (name) => `${name}_${Date.now()}_${++toolCallCounter}`,
        });
      } catch (error) {
        const failure = options?.signal?.aborted ? transportAbortError(options.signal) : error;
        failTransportStream({ stream: events, output, error: failure, signal: options?.signal });
      }
    })();
    return events;
  };
  return {
    stream,
    streamSimple: (model, context, options) =>
      stream(model, context, {
        ...buildBaseOptions(model, options, resolveSimpleApiKey?.(model, options)),
        thinking: buildGoogleSimpleThinking(model, options),
      }),
  };
}
