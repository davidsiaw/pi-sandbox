# pa-checker — a second model audits the answer before you see it

An opt-in verification pass. When a model you have opted in finishes a run, a
**separate `pi` process running a different model** reads the system prompt the
answer was supposed to obey, your request, a log of every tool actually called,
and the final answer — then either passes it or hands back specific criticism,
which is fed to the first model for correction before you read anything.

It is off unless you ask for it, per model, and it costs nothing until you do.

## Turning it on

In `~/.pi/agent/models.json`, add a `checker` key to the model you want audited:

```json
{
  "providers": {
    "m5-max": {
      "baseUrl": "http://100.64.0.10:12345/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "models": [
        {
          "id": "Qwen3.6-35B-A3B-MLX-8bit",
          "contextWindow": 262144,
          "checker": "llama-cpp/Qwen3.6-27B-UD-Q4_K_XL"
        }
      ]
    }
  }
}
```

The value is anything `--model` accepts (`provider/id`, or a bare id). The long
form takes a budget:

```json
"checker": { "model": "llama-cpp/Qwen3.6-27B", "maxRounds": 3, "timeoutMs": 300000 }
```

| Field | Default | Meaning |
|---|---|---|
| `model` | — | the auditing model |
| `maxRounds` | `2` | revision attempts per request before the answer ships anyway |
| `timeoutMs` | `300000` | kill the audit after this long and hand the answer over |

Models with no `checker` key are never audited. `/checker` toggles the pass off
and on for the current session.

`checker` also works inside `modelOverrides`, which is the only way to attach one
to a built-in provider's model:

```json
"anthropic": { "modelOverrides": { "claude-sonnet-4-5": { "checker": "..." } } }
```

## What the checker is given

Five things, inline in its prompt:

- **the system prompt** the audited answer was supposed to obey — supplied as
  *data to check against*, explicitly not as instructions for the checker
- **the earlier conversation** — up to 24 prior messages, condensed: user text,
  agent text, and the *names* of tools called in those turns (not their results)
- **your request** — the latest user message
- **the tool log for this turn** — every tool call with its arguments, and
  whether the result was ok or an error
- **the final answer**

Plus one tool, `session_context`, for reading conversation history older than
that excerpt (`mode: "transcript"` to page through, `mode: "search"` to find
where something was discussed). It reads the parent session file, follows the
`parentId` chain from the current leaf, and therefore never reports a branch you
abandoned via `/fork` or `/tree` as though it happened.

The tool log is the part that matters. Without it the checker can only assess
whether an answer *sounds* right; with it, "I ran the tests and they pass" can be
checked against the fact that no test ever ran. That is the failure this
extension exists to catch.

### How much of a tool result it sees

Up to 4000 characters per result, **keeping both ends** when that binds, with a
loud `[TRUNCATED: N characters omitted from the MIDDLE …]` marker between them.
Newlines are preserved.

All three of those details are scar tissue from one false positive. The agent
defended itself by grepping a cached page and citing lines 279/291/293 verbatim.
The cap was 400 characters and truncation kept only the head, so the reviewer saw
the early matches around lines 35-161 and reported the cited lines as fabricated
— the evidence that settled the question was inside the part that got cut. And
`replace(/\s+/g, " ")` collapsed the newlines, destroying the line structure you
need to check a "line 279 says X" claim at all. Search output quotes what it
found *last*, so head-only truncation loses precisely the evidence a late
citation rests on.

The whole log is capped at 80k characters, newest calls kept, and says how many
it dropped.

### Why the earlier conversation is included

The first version sent only the latest turn. That window is fine for
"request → work → answer" and actively misleading for a conversation. A real
example: the user asked about the ritonavir disaster, the agent researched it
with three `yousoro_browse` calls and answered, the user replied *"oh wow
weird"*, and the agent followed up. The payload for that follow-up was
`request: "oh wow weird"`, `tools: none`, `answer: <a page about drug
polymorphs>` — from which the checker deduced, entirely correctly, that the
agent had answered a question nobody asked using research it never did. It
demanded a revision; the model spent a turn rebutting it, also correctly, in
front of the user.

The checker was reasoning well from false premises. `session_context` existed
and would have resolved it, but nothing told the checker its view was partial,
so it had no reason to look. The fix was on both sides: put the recent history
in the payload, and state plainly in the auditor's prompt that the tool log
covers this turn only, that a short remark is usually a reply rather than a
standalone request, and that an objection which one tool call would disprove is
a failed audit.

History is bounded (24 messages / 24k chars, most recent kept) and says so when
it drops anything. Tool *results* from earlier turns are never inlined — only
the call names, which is enough to show that the agent did go and look.

### Why the checker is shown its own objections

The same bug had a second half. Round 2 audits the model's *response* to round 1,
and that response is a reply to the checker — delivered as a `custom` message,
which is neither `user` nor `assistant`. The original loop handled only those two
roles, so it dropped the objection: the auditor was shown a reply refuting
criticism that, as far as it could see, nobody had made, and reported a "severe
FAITHFULNESS failure — the agent has hallucinated an entire critique." The
checker had attacked the model for answering the checker.

Anything injected into a turn is now shown under `what_happened_since_then`,
attributed to the audit rather than to the user, along with any **superseded
answer** — the reply that got objected to — so the auditor can judge whether the
new one improved on it. Narration that merely precedes a tool call ("Looking into
it.") is not counted as superseded; only an answer that ended a turn and was then
replaced.

The prompt was extended to match: an earlier round's objection is shown to you,
the final answer is probably a reply to it, that is the process working rather
than a fabrication, and **a reasoned disagreement citing evidence is a sufficient
response** — repeating an objection the agent has already rebutted, without
engaging the evidence, is itself a failed audit.

**The checker always starts from empty context.** Fresh process, `--no-session`,
no skills, no `AGENTS.md`, no context files. It cannot inherit the reasoning it
is supposed to be checking, and it cannot be talked round by it.

## "I can't verify this" is not a finding

The single biggest source of false positives is a category error: treating
*"unsupported by the excerpt I was given"* as *"unfaithful"*. Those are different
claims and only the second is worth interrupting you for.

The reviewer is told so in as many words, and told what to do instead: it can
open anything the agent could — the files it read, the `/tmp` caches a browse
tool wrote, the sources it cited. If a claim cites a file and a line, read that
file and that line. Raise a faithfulness concern when you have *looked* and the
evidence contradicts the claim, or when the tool log positively shows the work
never happened — not because the window in front of you is silent.

## Recall: the other kind of failure

Tuning against false positives buys false negatives, and the first one was
instructive. Asked "hi" in English, the model replied `你好！有什么我可以帮你的？` —
breaking a rule stated plainly in the system prompt it had been given. The
reviewer said **looks good**.

Nothing was missing from the payload; `ctx.getSystemPrompt()` includes the
`APPEND_SYSTEM` text, so the rule was right there. The carve-outs added to stop
it inventing objections had simply grown wide enough to swallow a real one:
*"leave style and taste alone"* (a language is a style?) and *"conversation
deserves answers in kind"* (so a greeting needs no scrutiny).

The line is now drawn where it belongs — **your** taste is out of scope, a rule
the user wrote down never is:

> The test is simple: could you point at the line being broken? Then it is in
> scope, however minor. Is it just how you would have phrased it? Then it is not.

Compliance is also no longer judged by feel. The reviewer is told to find the
concrete, checkable rules in the system prompt and hold the answer against each,
with language, format, always/never and required steps named as the ones most
often missed — "because the answer reads perfectly well until you actually
check".

### `checked`

The verdict now carries a list of what the reviewer actually held the answer
against, and it is shown to you:

```
pa-checker: looks good (m5-max/Qwen3.6-27B) · checked: reply language matches the user's, no claims about files
```

It is a forcing function — enumerating is harder to skip than gesturing — and it
is how you tell a real review from a skimmed one. It is optional: a verdict
without it still passes, because a nudge toward better reviews must never become
a new way for the review to fail.

## Tone

The reviewer's words are read by the model on every revision, and by you whenever
the budget runs out, so it is written to sound like a colleague giving a second
read rather than a prosecutor building a case. It is told to assume competence
and good faith, that most answers are fine and saying so is a real outcome, to
leave style and taste alone, and to write any concern the way it would want one
written to itself: specific, concrete, about the answer rather than the agent.

This is not politeness for its own sake. An adversarial reviewer reaches for an
objection to justify its existence, and a reviewer that believes passing is
failure will always find something.

## The checker cannot write anything

It runs unattended against your real project directory, so this is enforced three
independent times:

1. `--tools read,ls,find,grep,session_context` — an allowlist. `sdk.js` turns
   `options.tools` into the complete set of active tools.
2. `--exclude-tools bash,edit,write` — a denylist filtered on top of it.
3. A `tool_call` hook in `child.ts` that blocks any non-read-only tool at
   execution time, whatever flags the process was started with.

Built-in tools are exactly `bash`, `edit`, `write`, `read`, `ls`, `find`, `grep`,
so the read-only set is `read`, `ls`, `find`, `grep`. One flag typo should not be
the only thing standing between an auditor and your files.

## While it runs

`agent_settled` fires *after* the answer has been printed, so the transcript
looks finished and the natural assumption is that it is your turn. It is not —
pi awaits the handler. Without an indicator the verdict arrives from nowhere,
seconds after you started typing.

So the audit shows a ticking widget **above the editor**, where you are already
looking:

```
⏳ pa-checker — verifying this answer with llama-cpp/Qwen3.6-27B (4s)
   not your turn yet; anything you type is queued until the verdict lands
```

plus a `checking Ns` footer status. Both are cleared on every exit path — pass,
revise, timeout, crash. The elapsed counter is there so a slow checker is
visibly alive rather than apparently hung.

Anything you type meanwhile is not lost; pi queues it and it runs once the
verdict lands.

The progress ticker is a `setInterval`, which in this codebase is a known
hazard: `ctx.ui` is a getter that **throws** once its session has been replaced,
so a timer that outlives its session takes pi down from a callback nothing can
catch (see [testing.md](testing.md) for the `pa-anthropic-oauth` incident). The
ticker is cleared in `finally` and on `session_shutdown`, its callback swallows a
stale-ctx throw, and every notification goes through a `safeNotify` wrapper for
the same reason. The selftest counts intervals and replaces the session
mid-audit to prove it.

## What it does with the verdict

The checker replies with `{"verdict":"pass"}` or
`{"verdict":"revise","criticism":"…"}`.

- **pass** — a one-line note in the UI, nothing enters the conversation.
- **revise, budget remaining** — the criticism is injected as a displayed
  message and the model is asked to correct itself immediately. You see both the
  objection and the correction.
- **revise, budget spent** — the answer **ships as-is**. The criticism is shown
  to you immediately *and* placed in context, so if you follow up the model
  already knows what was objected to. It does not trigger another turn.

  This uses `sendMessage(msg)` with **no options**, not `deliverAs: "nextTurn"`.
  `nextTurn` only pushes onto `_pendingNextTurnMessages` and emits no
  `message_start`/`message_end`, so the criticism stayed invisible until the
  user's next prompt dragged it onscreen — appearing to arrive *after* a question
  it predated. The bare branch (not streaming, no `triggerTurn`) appends to
  state, persists to the session and emits, so it renders at once and is still in
  context next turn, without starting one.

The loop always terminates in a shipped answer. A checker that can demand another
round forever is an unbounded bill.

## It fails open, always

Unreachable checker model, malformed verdict, timeout, crash — you get the
original answer plus a one-line warning, and nothing is injected. A verification
pass that can block your work when it breaks is worse than not having one.

Also never audited: answers you interrupted (`stopReason: "aborted"`), answers
that errored, and turns that produced no text.

## Why it hooks `agent_settled`

`agent_end` fires when a low-level run ends, but pi may still auto-retry,
auto-compact and retry, or drain queued follow-ups — auditing there would fire
mid-thought and several times per response. `agent_settled` means pi will not
continue on its own, which is exactly "about to hand back to the user".

`agent-session.js` sets `_isAgentRunActive = false` and then **awaits** extension
handlers, so the audit can block there, and a message sent from it with
`triggerTurn` starts a clean new run.

A consequence worth knowing: **turns that only call tools never settle**, so a
long tool-using stretch is not audited step by step. Only the final word is
checked. That is also why the extra model call is once per response, not once per
turn.

## Why the criticism arrives as a user-role message

Feeding it back as the assistant's own words ("wait, I'm violating X") is not
expressible in pi. `messages.js` `convertToLlm()` maps `role: "custom"` to
`role: "user"` unconditionally, and `sessionManager` is read-only to extensions.
The only way to forge an assistant turn is rewriting the payload in the `context`
hook on every call — which lives outside the session, must be re-injected
forever, and lands as a trailing assistant message whose prefill semantics
OpenAI-compatible local servers disagree about.

So it is a custom message with `customType: "pa-checker"`: rendered distinctly,
honest about where it came from, worded as the third-party audit it is.

## Why models.json is re-read instead of using `ctx.model.checker`

Unknown keys do survive into the model object — `ModelDefinitionSchema` is a
non-strict TypeBox object, and `provider-composer.js` spreads `...definition`.
But `applyModelOverride()` rebuilds the model from a fixed field list, so a
`checker` in `modelOverrides` is silently dropped — exactly the case you hit
attaching a checker to a built-in provider's model. Reading the file directly
treats both placements the same and does not rest on an undocumented spread.
It is re-read on each audit, so editing `models.json` mid-session takes effect
immediately, the same way pi reloads it when you open `/model`.

## Costs

One extra model call per response, on the audited model only. On a short answer
this roughly doubles latency, and the payload is large by design — the whole
system prompt and tool log go in. Point `checker` at a small local model.

Remember the checker is a second opinion from a model that saw *less* context
than the first one. It will sometimes be confidently wrong, which is why the
round budget exists and why its objections are always shown to you rather than
resolved silently.

## Files

```
pa-extensions/pa-checker/
├── index.ts       parent side: agent_settled hook, config, spawn, verdict, feedback
├── child.ts       loaded only in the checker process: session_context + read-only guard
└── selftest.mjs   node selftest.mjs — auth-free, drives the real spawn path
```

The selftest puts a fake `pi` first on `PATH` rather than stubbing
`child_process`, so the real argv, the real JSON-lines parsing and the real
timeout all execute. It is wired into [testing.md](testing.md).
