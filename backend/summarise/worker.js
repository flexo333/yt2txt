import { jobKindFor } from "./dispatch-pure.js";
import { allowedModelValues } from "./models.js";
import { runPersonJob, resumeStalledJobs } from "./people.js";
import { runBackfill } from "./backfill.js";

// The worker Lambda entry: the three internally-invoked job types, and nothing
// public. Same bundle as web.js, opposite settings — 900 s, `lambda:Invoke-
// Function` on itself for continuations, and full read/write on all three
// tables including DeleteItem for the backfill's canonical-key pass.
//
// Its three callers: the research kickoff (from the web function), its own
// time-budget continuations, and the EventBridge resumer tick. The backfill is
// invoked by hand — against *this* function, not the URL one.

export async function handler(event, context) {
  const kind = jobKindFor(event);

  if (kind === "person") {
    await runPersonJob(event.person, await allowedModelValues(), context);
    return { statusCode: 200, body: "ok" };
  }

  if (kind === "backfill") {
    const result = await runBackfill(event, context);
    console.log("runBackfill", JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  }

  if (kind === "resume") {
    const result = await resumeStalledJobs();
    console.log("resumeStalledJobs", JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  }

  // Returned rather than thrown: an async invoke that throws is retried twice
  // by Lambda, and replaying an event nobody can dispatch helps no one.
  console.error("worker: unrecognised event, no job key present:", JSON.stringify(event ?? null));
  return { statusCode: 400, body: JSON.stringify({ error: "unsupported event" }) };
}
