// derived https://github.com/nolanlawson/promise-worker

import assertNever from "assert-never";

type WorkerMessage<T> = Record<"messageId", number> &
  WorkerMessageCallbackArg<T>;
type WorkerMessageCallbackArg<T> =
  | { type: "error"; result: any }
  | { type: "result"; result: T };
type MainMessage<T> = [messageId: number, message: T];

const props = ["messageId", "type", "result"] as const;
const isWorkerMessage = <T>(msg: any): msg is WorkerMessage<T> =>
  Object.keys(msg).every((key) => props.includes(key as any));

/**
 * A wrapper class to promisify web workers
 */
export class PromiseWorker<TInput, TResult> {
  private _worker: Worker;
  private _callbacks = new Map<
    number,
    (msg: WorkerMessageCallbackArg<TResult>) => any
  >();

  /**
   * Pass in the worker instance to promisify
   *
   * @param worker The worker instance to wrap
   */
  constructor(worker: Worker | (new () => Worker)) {
    const w = worker instanceof Worker ? worker : new worker();
    this._worker = w;
    w.addEventListener("message", (evt: MessageEvent) => {
      let { data: msg } = evt;
      // Ignore - this message is not for us.
      if (!isWorkerMessage<TResult>(msg) || !this._callbacks.has(msg.messageId))
        return;

      this._callbacks.get(msg.messageId)!(msg);
      this._callbacks.delete(msg.messageId);
    });
  }

  public terminate(): void {
    this._worker.terminate();
  }

  /**
   * Send a message to the worker
   *
   * The message you send can be any object, array, string, number, etc.
   * Note that the message will be `JSON.stringify`d, so you can't send functions, `Date`s, custom classes, etc.
   *
   * @param userMessage Data or message to send to the worker
   * @returns Promise resolved with the processed result or rejected with an error
   */
  public postMessage(userMessage: TInput): Promise<TResult> {
    let messageId = +new Date();

    let messageToSend: MainMessage<TInput> = [messageId, userMessage];

    return new Promise((resolve, reject) => {
      this._callbacks.set(messageId, (msg) => {
        if (msg.type === "error") {
          reject(new Error(msg.result.message));
        } else if (msg.type === "result") {
          resolve(msg.result);
        } else assertNever(msg);
      });

      /* istanbul ignore if */
      // if (typeof this._worker.controller !== "undefined") {
      //   // service worker, use MessageChannels because e.source is broken in Chrome < 51:
      //   // https://bugs.chromium.org/p/chromium/issues/detail?id=543198
      //   let channel = new MessageChannel();
      //   channel.port1.onmessage = function (e) {
      //     onMessage(self, e);
      //   };
      //   this._worker.controller.postMessage(messageToSend, [channel.port2]);
      // } else
      // web worker
      this._worker.postMessage(messageToSend);
    });
  }
}

const isPromise = (obj: any): obj is Promise<any> => {
  // via https://unpkg.com/is-promise@2.1.0/index.js
  return (
    !!obj &&
    (typeof obj === "object" || typeof obj === "function") &&
    typeof obj.then === "function"
  );
};
// const tryCatchFunc = <T>(callback:T=>, message) => {
//   try {
//     return { res: callback(message) };
//   } catch (e) {
//     return { err: e };
//   }
// };

/**
 * Make this worker a promise-worker
 * @param callback Callback function for processing the inbound data
 */
export const registerPromiseWorker = <TMessageIn, TMessageOut>(
  callback: (message: TMessageIn) => Promise<TMessageOut> | TMessageOut,
): void => {
  const postOutgoingMessage = (data: WorkerMessage<TMessageOut>) => {
    if (data.type === "error") {
      if (typeof console !== "undefined" && "error" in console) {
        // This is to make errors easier to debug. I think it's important
        // enough to just leave here without giving the user an option
        // to silence it.
        console.error("Worker caught an error:", data.result);
      }
    }
    /* istanbul ignore if */
    // if (typeof self.postMessage !== "function") {
    //   // service worker
    //   e.ports[0].postMessage(msg);
    // } else
    // web worker
    self.postMessage(data);
  };

  self.addEventListener(
    "message",
    async (e: MessageEvent<MainMessage<TMessageIn>>) => {
      let payload = e.data;
      if (!Array.isArray(payload) || payload.length !== 2) {
        // message doens't match communication format; ignore
        return;
      }
      const [messageId, message] = payload;
      if (typeof callback !== "function") {
        return postOutgoingMessage({
          messageId,
          type: "error",
          result: "Please pass a function into register().",
        });
      }
      try {
        postOutgoingMessage({
          messageId,
          type: "result",
          result: await callback(message),
        });
      } catch (err) {
        postOutgoingMessage({ messageId, type: "error", result: err });
      }
    },
  );
};
