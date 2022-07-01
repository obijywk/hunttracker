import serverlessHttp from "serverless-http";

import { receiver } from "./app";
import * as refreshPolling from "./refresh_polling";
import * as taskQueue from "./task_queue";

require("./events");
require("./web");

// Lambda and Bolt don't play well together with respect to events... Bolt
// acks event posts before their handlers have finished running, and then
// Lambda halts execution even though there's still work remaining to be done.
//
// This hack adds an additional ack function to the body that's passed to the
// event handler, and prevents the Lambda handler from returning until this ack
// function is executed.
//
// This hack is now broken after upgrading Bolt to version 3... if anyone wants to
// run this on AWS, this will need to be rewritten and reintroduced.
/*
const logMessageEvents = process.env.LOG_MESSAGE_EVENTS !== undefined;
const messageEventListeners = receiver.listeners("message");
for (const messageEventListener of messageEventListeners) {
  receiver.removeListener("message", messageEventListener as (...args: any[]) => void);
  receiver.addListener("message", async (message) => {
    if (logMessageEvents) {
      console.info("Received", JSON.stringify(message));
    }
    const originalAck = message.ack;
    const ackArgsPromise = new Promise<any[]>((resolve) => {
      message.ack = (...ackArgs: any[]) => resolve(ackArgs);
    });
    const eventAckPromise = new Promise((resolve) => {
      if (message.body.event !== undefined) {
        message.body.eventAck = resolve;
      } else {
        resolve(undefined);
      }
    });
    await messageEventListener(message);
    const ackArgs = await ackArgsPromise;
    await eventAckPromise;
    originalAck(...ackArgs);
  });
}
*/

export const handler = serverlessHttp(receiver.app);

export const refresh = async (
  event: any/*: AWSLambda.APIGatewayEvent*/,
  context: any/*: AWSLambda.APIGatewayEventRequestContext*/,
) => {
  await refreshPolling.refresh();
};

export const processTaskQueue = async (
  event: any/*: AWSLambda.APIGatewayEvent*/,
  context: any/*: AWSLambda.APIGatewayEventRequestContext*/,
) => {
  await taskQueue.processTaskQueue();
};
