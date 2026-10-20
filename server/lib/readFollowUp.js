// The comment and file read queues (submissionComments.js, submissionFiles.js) let a
// call join a read job already running for the same key. Whether the call must read
// again once that job is done (#170): it wants fresher reads than the job (a smaller
// maxAgeSec: the grading sync's 0 joining a page's job), or it wants every read made
// after it started (maxAgeSec 0) and the job started earlier (`asOf`, epoch seconds).
// A page's call (a larger or equal maxAgeSec) just joins.
export const needsFollowUp = (running, { maxAgeSec, asOf }) =>
  maxAgeSec < running.maxAgeSec || (maxAgeSec === 0 && running.asOf < asOf);
