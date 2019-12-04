import serverlessHttp from "serverless-http";

import { receiver } from "./app";
import * as refreshPolling from "./refresh_polling";
import * as taskQueue from "./task_queue";

require("./web");

// Lambda and Bolt don't play well together with respect to events... Bolt
// acks event posts before their handlers have finished running, and then
// Lambda halts execution even though there's still work remaining to be done.
//
// This hack adds an additional ack function to the body that's passed to the
// event handler, and prevents the Lambda handler from returning until this ack
// function is executed.
const messageEventListeners = receiver.listeners("message");
for (const messageEventListener of messageEventListeners) {
  receiver.removeListener("message", messageEventListener as (...args: any[]) => void);
  receiver.addListener("message", async (message) => {
    const originalAck = message.ack;
    const ackArgsPromise = new Promise<any[]>((resolve) => {
      message.ack = (...ackArgs: any[]) => resolve(ackArgs);
    });
    const eventAckPromise = new Promise((resolve) => {
      if (message.body.event !== undefined) {
        message.body.eventAck = resolve;
      } else {
        resolve();
      }
    });
    await messageEventListener(message);
    const ackArgs = await ackArgsPromise;
    await eventAckPromise;
    originalAck(...ackArgs);
  });
}

export const handler = serverlessHttp(receiver.app);

export const refresh = async (
  event: AWSLambda.APIGatewayEvent,
  context: AWSLambda.APIGatewayEventRequestContext,
) => {
  await refreshPolling.refresh();
};

export const processTaskQueue = async (
  event: AWSLambda.APIGatewayEvent,
  context: AWSLambda.APIGatewayEventRequestContext,
) => {
  await taskQueue.processTaskQueue();
};