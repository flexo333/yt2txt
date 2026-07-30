import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// The one place a Lambda invoke is issued. Every internal job — the research
// kickoff from the request path, the worker's own continuations, and the
// safety-net resumer's nudges — targets the *worker* function, so they all go
// through here rather than each caller naming a function.
//
// Name resolution, in order:
//   WORKER_FUNCTION_NAME     set by Pulumi on the web function, which cannot
//                            learn the worker's name any other way. Not set on
//                            the worker itself: that would be a circular
//                            dependency (a function's own name in its own env).
//   AWS_LAMBDA_FUNCTION_NAME injected by the runtime. On the worker this *is*
//                            the worker, so its continuations keep working
//                            unchanged; it also keeps a single-function
//                            deployment (web and worker in one) correct.

const lambda = new LambdaClient({});

export function workerFunctionName() {
  return process.env.WORKER_FUNCTION_NAME || process.env.AWS_LAMBDA_FUNCTION_NAME || "";
}

// Fire-and-forget: InvocationType "Event" returns as soon as the payload is
// queued, so the caller never waits on the job it just started.
export async function invokeWorker(payload) {
  const FunctionName = workerFunctionName();
  if (!FunctionName) {
    throw new Error("invokeWorker: neither WORKER_FUNCTION_NAME nor AWS_LAMBDA_FUNCTION_NAME is set");
  }
  await lambda.send(new InvokeCommand({
    FunctionName,
    InvocationType: "Event",
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
}
