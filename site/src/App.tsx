import type { ReactNode } from "react";
import { Mark } from "./Mark.tsx";

const NAV = [
  ["Specification", "https://github.com/provene-hq/provene/blob/main/spec/rfc/0001-receipt-schema.md"],
  ["Assurance tiers", "#tiers"],
  ["Agents", "#agents"],
  ["Threat model", "https://github.com/provene-hq/provene/blob/main/spec/threat-model.md"],
  ["Writing", "/writing/"],
  ["Source", "https://github.com/provene-hq/provene"],
] as const;

const RECORDS = [
  "Agent and model, as reported by the tool",
  "Which files changed, and which the agent was observed to touch",
  "Which commands ran, and what their outcomes were",
  "Who attested to all of it, at what assurance tier",
];

/** Each row is what the runtime showed, not what the vendor documented. */
const AGENTS = [
  { name: "Claude Code", ver: null, wiring: "Hooks", outcome: "Success and failure",
    tone: "ok", why: "Running it. Two events, both observed." },
  { name: "Gemini CLI", ver: "0.57.0", wiring: "Hooks", outcome: "From tool_response",
    tone: "part", why: "Hooks fire, confirmed. Payload shape read from source, not yet run." },
  { name: "Codex CLI", ver: "0.147.0", wiring: "Hooks, behind a flag", outcome: "The event is the outcome",
    tone: "ok", why: "Running it. PostToolUse fires only on success — verified three ways." },
  { name: "Antigravity", ver: "2.11.0.0", wiring: "Transcript import", outcome: "From step order",
    tone: "part", why: "Five experiments. Its documented hooks do not fire." },
] as const;

const TIERS = [
  { t: "T0", by: "Your machine, unsigned", worth: "Local visibility. Satisfies no policy.", kind: "" },
  { t: "T1", by: "Your machine, your identity", worth: "Attribution among people who already trust each other.", kind: "" },
  { t: "T2", by: "CI, on a runner you do not control", worth: "Verification evidence, independently observed.", kind: "now" },
  { t: "T3", by: "Execution environment or agent vendor", worth: "Authorship. Reserved; nothing produces it yet.", kind: "soon" },
] as const;

const SPEC = [
  ["RFC 0001 — the normative document", "v0.1.11", "https://github.com/provene-hq/provene/blob/main/spec/rfc/0001-receipt-schema.md"],
  ["Receipt JSON Schema", "/schema/receipt/v0.1", "/schema/receipt/v0.1.json"],
  ["The code-change predicate", "v0.1", "/attestation/code-change/v0.1"],
  ["Aggregate JSON Schema", "/schema/aggregate/v0.1", "/schema/aggregate/v0.1.json"],
  ["The code-change-aggregate predicate", "v0.1", "/attestation/code-change-aggregate/v0.1"],
  ["Policy JSON Schema", "/schema/policy/v1", "/schema/policy/v1.json"],
] as const;

function Section({ n, title, blurb, children }: {
  n: number; title: string; blurb?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="section" id={title.toLowerCase().replace(/[^a-z]+/g, "-")}>
      <div className="wrap section__grid">
        <div>
          <p className="eyebrow">Section {n}</p>
          <h2 style={{ margin: "12px 0 14px" }}>{title}</h2>
          {blurb !== undefined && <p style={{ fontSize: "14.5px", color: "var(--body)" }}>{blurb}</p>}
        </div>
        <div>{children}</div>
      </div>
    </section>
  );
}

export function App() {
  return (
    <>
      <div className="util">
        <div className="wrap">
          <span>RFC 0001 · v0.1.11</span>
          <span className="util__sep" aria-hidden="true">|</span>
          <span>proveneio 0.9.1</span>
          <span className="util__id">predicate&nbsp; provene.dev/attestation/code-change/v0.1</span>
        </div>
      </div>

      <header className="nav">
        <div className="wrap">
          <a className="brand" href="/"><Mark size={30} tone="light" /><span>PROVENE</span></a>
          <nav className="nav__links">
            {NAV.map(([label, href]) => <a key={label} href={href}>{label}</a>)}
          </nav>
        </div>
      </header>

      <main>
        <div className="hero">
          <div className="hero__main">
            <div className="tags">
              <span className="tag">OPEN FORMAT</span>
              <span className="tag">APACHE-2.0</span>
              <span className="tag">NO SERVICE REQUIRED</span>
            </div>
            <h1>Evidence receipts for <span style={{ whiteSpace: "nowrap" }}>AI-generated</span> code changes</h1>
            <p className="lede">
              A portable record of what an agent changed, and what was actually run against it
              before merge. Committed with the change, verifiable by anyone, tied to no vendor.
            </p>
            <div className="cta">
              <a className="btn" href="https://github.com/provene-hq/provene#readme">Get started</a>
              <span className="cmd">npm install -g proveneio</span>
            </div>
          </div>
          <aside className="hero__aside">
            <p className="eyebrow">What a receipt records</p>
            <ol className="numbered">{RECORDS.map((r) => <li key={r}>{r}</li>)}</ol>
            <p className="note">
              Bound to the change set by content digest. An in-toto Statement, committed
              in-tree alongside the code it describes.
            </p>
            <p className="note">
              No prompt text. No argument vector. No file contents. Prompts are recorded as a
              keyed HMAC digest or not at all.
            </p>
          </aside>
        </div>

        <Section n={1} title="The problem, in one diff"
          blurb={<>An agent adds discount codes to a cart. It writes <code>src/discount.ts</code>, adds a
            test for it, edits <code>src/cart.ts</code>, and runs the suite. Everything is green.
            The discount code is never applied.</>}>
          <div className="stack">
            <div className="file">
              <p className="file__name">src/cart.ts&nbsp; <span style={{ color: "var(--accent)" }}>3 changed lines</span></p>
              <pre className="file__body">
<span className="gutter"> 7</span>  export function total(items: Item[], <span className="chg">code: string</span>): number {'{'}
<span className="gutter"> 8</span>    <span className="chg">const shipping = subtotal(items) &gt; 5000 ? 0 : 499;</span>
<span className="gutter"> 9</span>    <span className="chg">return subtotal(items) + shipping;</span>
<span className="gutter">10</span>  {'}'}
              </pre>
            </div>
            <div className="three">
              <div className="stat"><p className="stat__n">GitHub</p><p className="stat__p">answers for Copilot — inside GitHub</p></div>
              <div className="stat"><p className="stat__n">GitLab</p><p className="stat__p">answers for Duo — inside GitLab</p></div>
              <div className="stat stat--us"><p className="stat__n">Everyone else</p><p className="stat__p">three vendors and a self-hosted runner — nobody can answer at all</p></div>
            </div>
          </div>
        </Section>

        <Section n={2} title="What a reviewer sees"
          blurb={<>Not “an AI wrote this”. These specific changed lines had nothing run against them.</>}>
          <pre className="term">
<span className="p">$</span> provene check --base origin/main --coverage lcov.info{"\n"}
<span className="d">1/1 receipt(s) well formed (T0)</span>{"\n"}
<span className="d">3 changed path(s); 3 carry agent attribution from this change</span>{"\n"}
<span className="w">4/9 executable changed lines executed by the test run</span>{"\n"}
<span className="d i">src/cart.ts: 3 of 3 executable changed lines unverified</span>{"\n"}
<span className="d i">src/discount.ts: 2 of 4 executable changed lines unverified</span>
          </pre>
        </Section>

        <Section n={3} title="Two commands, no fork"
          blurb={<><code>init</code> installs the hooks into your agent’s own settings file, merging
            rather than replacing. <code>doctor</code> tells you whether they are actually wired up.</>}>
          <div className="stack">
            <pre className="file__body file" style={{ borderColor: "var(--rule)" }}>
npm install -g proveneio{"\n"}
provene init<span className="gutter">                    # Claude Code</span>{"\n"}
provene init --agent gemini<span className="gutter">     # Gemini CLI</span>{"\n"}
provene doctor
            </pre>
            <div className="three">
              <div className="card"><p className="card__h">Nothing leaves the machine</p><p className="card__p">No account, no server, no telemetry. The journal lives outside the repository.</p></div>
              <div className="card"><p className="card__h">One file per change</p><p className="card__p">A JSON receipt committed in-tree, collapsed in review by a gitattributes stanza.</p></div>
              <div className="card"><p className="card__h">CI does the signing</p><p className="card__p">A GitHub Action promotes a T0 receipt to a signed T2 aggregate on the pull request.</p></div>
            </div>
          </div>
        </Section>

        <Section n={4} title="Agent support"
          blurb={<>Every row was established by running the agent or reading its source — never from
            its documentation alone. Where a claim has not yet been confirmed against a running
            tool, the table says so.</>}>
          <div className="wrapx">
            <table className="matrix">
              <thead><tr><th>Agent</th><th>Wiring</th><th>Outcomes</th><th>Established by</th></tr></thead>
              <tbody>
                {AGENTS.map((a) => (
                  <tr key={a.name}>
                    <td>{a.name}{a.ver !== null && <> <span className="ver">{a.ver}</span></>}</td>
                    <td style={{ color: "var(--body)" }}>{a.wiring}</td>
                    <td style={{ color: a.tone === "ok" ? "var(--ok)" : "var(--warn)" }}>{a.outcome}</td>
                    <td className="why">{a.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ marginTop: 16, fontSize: "13.5px", color: "var(--body)" }}>
            What it took to establish these rows: “Three coding agents document a hooks system.
            One of them works.” <a href="/writing/three-agents-one-hooks-system">Read the write-up →</a>
          </p>
        </Section>

        <section className="section" id="tiers">
          <div className="wrap">
            <p className="eyebrow">Section 5</p>
            <h2 style={{ margin: "12px 0 22px" }}>Assurance tiers</h2>
            <div className="cards">
              {TIERS.map((t) => (
                <div key={t.t} className={t.kind === "now" ? "card card--now" : t.kind === "soon" ? "card card--soon" : "card"}>
                  <p className="card__t" style={t.kind === "now" ? { color: "var(--ok)" } : t.kind === "soon" ? { color: "#4d5866" } : undefined}>{t.t}</p>
                  <p className="card__h">{t.by}</p>
                  <p className="card__p">{t.worth}</p>
                </div>
              ))}
            </div>
            <p style={{ marginTop: 20, fontSize: "14.5px", color: "var(--body)", maxWidth: "56em" }}>
              A locally observed test run satisfies no policy on its own. It is a self-attestation
              by the party who wants the change merged, and the tool says so in its own output
              rather than leaving you to work it out.
            </p>
          </div>
        </section>

        <Section n={6} title="What it does not prove">
          <div className="two">
            <div className="stack stack--tight">
              <p style={{ color: "var(--body)", fontSize: "14.5px" }}>
                A receipt does not assert that an agent authored a change, that code is correct,
                secure or well-designed, or that unattributed regions of a diff were written by a human.
              </p>
              <p className="pull">Absence of attribution means <strong>unobserved</strong>, never human.</p>
            </div>
            <div className="stack stack--tight">
              <p style={{ color: "var(--body)", fontSize: "14.5px" }}>
                Forged authorship is an explicit non-goal: no format can distinguish typing from
                generating. What CI counter-signing does close is forged test evidence — a claim
                that a suite passed when it did not.
              </p>
              <p><a className="mono" style={{ fontSize: "13.5px" }}
                    href="https://github.com/provene-hq/provene/blob/main/spec/threat-model.md">Read the threat model →</a></p>
            </div>
          </div>
        </Section>

        <section className="section" style={{ borderBottom: "none" }} id="specification">
          <div className="wrap">
            <p className="eyebrow">Section 7</p>
            <h2 style={{ margin: "12px 0 8px" }}>Specification</h2>
            <p style={{ margin: "0 0 24px", fontSize: "14.5px", color: "var(--body)", maxWidth: "56em" }}>
              The schemas served here are the same bytes as <code>spec/schema/</code> in the
              repository, checked by a test on every run.
            </p>
            <div className="index">
              {SPEC.map(([label, ver, href]) => (
                <a key={label} href={href}><span>{label}</span><span className="ver">{ver}</span></a>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap">
          <span className="brand"><Mark size={24} tone="dark" /><span>PROVENE</span></span>
          <a href="https://github.com/provene-hq/provene/blob/main/LICENSE">Apache-2.0</a>
          <a href="https://github.com/provene-hq/provene">github.com/provene-hq/provene</a>
          <a href="https://www.npmjs.com/package/proveneio">npm: proveneio</a>
          <span className="foot__end">The apex is the identifier; www is a convenience.</span>
        </div>
      </footer>
    </>
  );
}
