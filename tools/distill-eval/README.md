# @argus/distill-eval

Replay + judge harness for the case-distill prompt. Dev tool; never ships in the app.

## What the corpus is

An NDJSON file exported from the app's dev Prompts page: one line per case-distill
job, each line a `DistillEvalBundleLine` (the job's frozen `inputSnapshot`, its
stored `promptHash` and `rawOutput`, and the human accept/reject outcomes recorded
against its proposals).

## Privacy caveat

Corpus lines carry raw case data — findings, evidence descriptions, chat session
titles, full skill/reference file contents. Treat exported corpus files as
sensitive: keep them out of version control and only use them in a private repo
or local checkout.

## Commands

```bash
npm install
npm run build
node dist/cli.js --corpus <path-to-corpus.ndjson> --out <path-to-results>
```

Full flags land in Task 7.
