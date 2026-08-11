import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { RuntimeNamespace, TopicCandidateDecisionInput, TopicInboxEvidenceOutput, TopicInboxTopic } from "@memmy/local-api-contracts";
import { Check, ChevronDown, ChevronRight, GitMerge, GitPullRequest, Inbox, Pause, Pencil, RefreshCw, X } from "lucide-react";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";

export interface TopicInboxProject { id: string; name: string }
export interface TopicInboxSubPageProps {
  client: MemoryRuntimeClient | null;
  projects: TopicInboxProject[];
  onPendingCountChange?: (count: number) => void;
}

type LoadState = "loading" | "ready" | "error";
const EVIDENCE_LIMIT = 20;

function namespace(projectId: string): RuntimeNamespace {
  return { source: "desktop", profileId: "default", projectId };
}
function mutation(projectId: string) {
  return { namespace: namespace(projectId), source: "desktop", adapterId: "memmy-desktop", requestId: `desktop-topic-${crypto.randomUUID()}` };
}
export function TopicInboxSubPage(props: TopicInboxSubPageProps) {
  const { client, projects } = props;
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [topics, setTopics] = useState<TopicInboxTopic[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [evidence, setEvidence] = useState<Record<string, TopicInboxEvidenceOutput | "loading" | "error">>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [splitDrafts, setSplitDrafts] = useState<Record<string, { title: string; summary: string; selected: string[] }>>({});
  const [refreshQueued, setRefreshQueued] = useState(false);

  async function load(selected = projectId) {
    if (!client || !selected) { setTopics([]); setState("ready"); return; }
    setTopics([]); setExpanded(new Set()); setEvidence({}); props.onPendingCountChange?.(0); setState("loading"); setMessage("");
    try {
      const output = await client.listTopicInbox({ namespace: namespace(selected) });
      const scopedTopics = output.projects.flatMap((group) => group.namespace.projectId === selected ? group.topics : []);
      setTopics(scopedTopics);
      props.onPendingCountChange?.(scopedTopics.reduce((sum, topic) => sum + topic.candidateCounts.pending, 0));
      setState("ready");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setState("error");
    }
  }

  useEffect(() => { void load(projectId); }, [client, projectId]);
  useEffect(() => { if (!projects.some((project) => project.id === projectId)) setProjectId(projects[0]?.id ?? ""); }, [projects, projectId]);

  const pendingCount = useMemo(() => topics.reduce((sum, topic) => sum + topic.candidateCounts.pending, 0), [topics]);

  async function refresh() {
    if (!client || !projectId) return;
    setBusy("refresh"); setMessage("");
    try {
      const result = await client.refreshTopicInbox(mutation(projectId));
      setRefreshQueued(!result.unchanged);
      setMessage(result.unchanged ? "Already up to date" : "Refresh queued; use Refresh again to check completion");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  }

  async function decide(candidate: TopicInboxTopic["candidates"][number], input: CandidateDecisionDraft) {
    if (!client) return;
    setBusy(candidate.id); setMessage("");
    try {
      await client.decideTopicCandidate(candidate.id, { ...input, ...mutation(projectId) } as TopicCandidateDecisionInput);
      setEditing(null); await load();
    } catch (error) {
      const conflictMessage = error instanceof Error ? error.message : String(error);
      await load();
      setMessage(conflictMessage);
    } finally { setBusy(null); }
  }

  async function toggleEvidence(topicId: string) {
    if (evidence[topicId]) { setEvidence((current) => { const next = { ...current }; delete next[topicId]; return next; }); return; }
    if (!client) return;
    setEvidence((current) => ({ ...current, [topicId]: "loading" }));
    try { const output = await client.topicEvidence(topicId, { namespace: namespace(projectId), limit: EVIDENCE_LIMIT }); setEvidence((current) => ({ ...current, [topicId]: output })); }
    catch { setEvidence((current) => ({ ...current, [topicId]: "error" })); }
  }

  async function merge(topic: TopicInboxTopic) {
    if (!client) return;
    const targetId = mergeTargets[topic.id];
    const target = topics.find((item) => item.id === targetId && item.status === "active");
    if (!target) { setMessage("Select a merge target"); return; }
    setBusy(topic.id);
    try { await client.mergeTopics(topic.id, { ...mutation(projectId), targetTopicId: target.id, expectedVersion: topic.version, targetExpectedVersion: target.version }); await load(); }
    catch (error) { const conflictMessage = error instanceof Error ? error.message : String(error); await load(); setMessage(conflictMessage); }
    finally { setBusy(null); }
  }

  async function split(topic: TopicInboxTopic) {
    const draft = splitDrafts[topic.id];
    if (!client || !draft?.title.trim() || draft.selected.length === 0) { setMessage("Enter a split title and select at least one evidence item"); return; }
    setBusy(topic.id);
    try { await client.splitTopic(topic.id, { ...mutation(projectId), expectedVersion: topic.version, title: draft.title.trim(), summary: draft.summary.trim(), evidenceMemoryIds: draft.selected }); await load(); }
    catch (error) { const conflictMessage = error instanceof Error ? error.message : String(error); await load(); setMessage(conflictMessage); }
    finally { setBusy(null); }
  }

  return <section className="mx-auto w-full max-w-6xl px-6" aria-labelledby="topic-inbox-title">
    <header className="mb-5 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1"><h1 id="topic-inbox-title" className="text-xl font-semibold text-text-ink">Topic inbox</h1><p className="text-sm text-text-ink/60">Review pending proposals before they enter stable project context.</p></div>
      <label className="text-sm text-text-ink/70">Project <select aria-label="Project" value={projectId} onChange={(event) => setProjectId(event.target.value)} className="ml-2 rounded border border-border bg-content-bg px-2 py-1.5">{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <button type="button" title="Refresh topic analysis" aria-label="Refresh topic analysis" disabled={!projectId || busy === "refresh"} onClick={() => void refresh()} className="sidebar-toolbar-button"><RefreshCw size={17} className={busy === "refresh" ? "animate-spin" : ""} /></button>{refreshQueued && <span role="status" className="text-xs">Queued</span>}
    </header>
    {message && <div role="status" className="mb-3 rounded border border-border px-3 py-2 text-sm">{message}</div>}
    {state === "loading" && <div aria-busy="true" className="min-h-40 py-8 text-sm text-text-ink/60">Loading topic inbox...</div>}
    {state === "error" && <div role="alert" className="min-h-40 py-8"><p>{message || "Could not load topic inbox."}</p><button type="button" onClick={() => void load()} className="mt-3 underline">Retry</button></div>}
    {state === "ready" && !projectId && <Empty icon={<Inbox />} text="No scoped projects are available." />}
    {state === "ready" && projectId && topics.length === 0 && <Empty icon={<Inbox />} text="No project topics yet." />}
    {state === "ready" && topics.length > 0 && <div className="space-y-6"><section aria-labelledby="stable-topics"><h2 id="stable-topics" className="mb-2 text-sm font-semibold">Stable topics</h2>{topics.map((topic) => {
      const open = expanded.has(topic.id); const loaded = evidence[topic.id];
      return <article key={topic.id} className="border-t border-border py-3">
        <div className="flex items-start gap-2"><button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${topic.title}`} onClick={() => setExpanded((current) => { const next = new Set(current); open ? next.delete(topic.id) : next.add(topic.id); return next; })} className="mt-1 p-1">{open ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}</button><div className="min-w-0 flex-1"><h3 className="font-medium">{topic.title}</h3><p className="text-sm text-text-ink/65">{topic.summary}</p><div className="mt-1 text-xs text-text-ink/50">{topic.evidenceCount} evidence · {topic.candidateCounts.approved} approved · {topic.status}</div></div></div>
        {open && <div className="ml-9 mt-3 space-y-3"><div className="flex flex-wrap items-center gap-2"><label className="text-sm">Merge into <select aria-label={`Merge target for ${topic.title}`} value={mergeTargets[topic.id] ?? ""} onChange={(event) => setMergeTargets((current) => ({ ...current, [topic.id]: event.target.value }))}><option value="">Select topic</option>{topics.filter((item) => item.id !== topic.id && item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><button type="button" disabled={busy === topic.id} onClick={() => void merge(topic)} className="inline-flex items-center gap-1 text-sm underline"><GitMerge size={16}/>Merge</button></div><button type="button" aria-expanded={Boolean(loaded)} onClick={() => void toggleEvidence(topic.id)} className="text-sm underline">{loaded ? "Hide raw evidence" : `Show raw evidence (up to ${EVIDENCE_LIMIT})`}</button>{loaded === "loading" && <p aria-busy="true">Loading evidence...</p>}{loaded === "error" && <p role="alert">Could not load evidence.</p>}{loaded && typeof loaded !== "string" && <div className="space-y-2 border-l-2 border-border pl-3"><fieldset><legend className="text-sm font-medium">Split topic</legend>{loaded.items.map((item) => <label key={item.id} className="flex gap-2 text-sm"><input type="checkbox" checked={splitDrafts[topic.id]?.selected.includes(item.memoryId) ?? false} onChange={(event) => setSplitDrafts((current) => { const draft = current[topic.id] ?? { title: "", summary: "", selected: [] }; return { ...current, [topic.id]: { ...draft, selected: event.target.checked ? [...draft.selected, item.memoryId] : draft.selected.filter((id) => id !== item.memoryId) } }; })}/>{item.role}: {item.summary}</label>)}<input aria-label={`Split title for ${topic.title}`} placeholder="New topic title" value={splitDrafts[topic.id]?.title ?? ""} onChange={(event) => setSplitDrafts((current) => ({ ...current, [topic.id]: { ...(current[topic.id] ?? { summary: "", selected: [] }), title: event.target.value } }))}/><textarea aria-label={`Split summary for ${topic.title}`} placeholder="Summary" value={splitDrafts[topic.id]?.summary ?? ""} onChange={(event) => setSplitDrafts((current) => ({ ...current, [topic.id]: { ...(current[topic.id] ?? { title: "", selected: [] }), summary: event.target.value } }))}/><button type="button" disabled={busy === topic.id} onClick={() => void split(topic)} className="inline-flex items-center gap-1 text-sm underline"><GitPullRequest size={16}/>Split selected evidence</button></fieldset>{loaded.items.map((item) => <details key={item.id}><summary>{item.role}: {item.summary}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{item.rawText}</pre></details>)}</div>}</div>}
      </article>;
    })}</section><section aria-labelledby="candidate-review"><h2 id="candidate-review" className="mb-2 text-sm font-semibold">Pending and deferred review ({pendingCount})</h2>{topics.flatMap((topic) => topic.candidates.filter((candidate) => candidate.status === "pending" || candidate.status === "deferred")).map((candidate) => <Candidate key={candidate.id} candidate={candidate} busy={busy === candidate.id} editing={editing === candidate.id} onEdit={() => setEditing(candidate.id)} onDecide={decide} />)}{pendingCount === 0 && <p className="text-sm text-text-ink/55">No candidates awaiting review.</p>}</section></div>}
  </section>;
}
type CandidateDecisionDraft = Omit<Extract<TopicCandidateDecisionInput, { action: "approve" }>, "namespace"> | Omit<Extract<TopicCandidateDecisionInput, { action: "edit_and_approve" }>, "namespace"> | Omit<Extract<TopicCandidateDecisionInput, { action: "reject" }>, "namespace"> | Omit<Extract<TopicCandidateDecisionInput, { action: "defer" }>, "namespace">;
function Action({ icon, label, disabled, action }: { icon: ReactNode; label: string; disabled: boolean; action: () => void | Promise<void> }) { return <button type="button" disabled={disabled} onClick={() => void action()} className="inline-flex items-center gap-1 text-sm underline">{icon}{label}</button>; }
function Empty({ icon, text }: { icon: ReactNode; text: string }) { return <div className="min-h-40 py-10 text-center text-text-ink/55">{icon}<p className="mt-2">{text}</p></div>; }
function Candidate({ candidate, busy, editing, onEdit, onDecide }: { candidate: TopicInboxTopic["candidates"][number]; busy: boolean; editing: boolean; onEdit: () => void; onDecide: (candidate: TopicInboxTopic["candidates"][number], input: CandidateDecisionDraft) => Promise<void> }) {
  const [title, setTitle] = useState(candidate.title); const [conclusion, setConclusion] = useState(candidate.conclusion);
  return <div className="rounded border border-border bg-content-bg p-3" tabIndex={0} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void onDecide(candidate, editing ? { action: "edit_and_approve", expectedVersion: candidate.version, title: title.trim(), conclusion: conclusion.trim(), proposedLayer: candidate.proposedLayer } : { action: "approve", expectedVersion: candidate.version }); }}><div className="flex items-center gap-2"><span className="text-xs font-semibold">{candidate.proposedLayer} proposed</span><span className="text-xs text-text-ink/50">{candidate.status}</span></div>{editing ? <div className="mt-2 grid gap-2"><input aria-label="Candidate title" value={title} onChange={(event) => setTitle(event.target.value)} className="rounded border border-border px-2 py-1"/><textarea aria-label="Candidate conclusion" value={conclusion} onChange={(event) => setConclusion(event.target.value)} className="rounded border border-border px-2 py-1"/><button disabled={busy || !title.trim() || !conclusion.trim()} onClick={() => void onDecide(candidate, { action: "edit_and_approve", expectedVersion: candidate.version, title: title.trim(), conclusion: conclusion.trim(), proposedLayer: candidate.proposedLayer })}>Save and approve</button></div> : <><h3 className="mt-1 font-medium">{candidate.title}</h3><p className="text-sm">{candidate.conclusion}</p><div className="mt-2 flex flex-wrap gap-3"><Action icon={<Check size={15}/>} label="Approve" disabled={busy} action={() => onDecide(candidate, { action: "approve", expectedVersion: candidate.version })}/><Action icon={<Pencil size={15}/>} label="Edit" disabled={busy} action={onEdit}/><Action icon={<X size={15}/>} label="Reject" disabled={busy} action={() => onDecide(candidate, { action: "reject", expectedVersion: candidate.version })}/><Action icon={<Pause size={15}/>} label="Defer" disabled={busy} action={() => onDecide(candidate, { action: "defer", expectedVersion: candidate.version })}/></div></>}</div>;
}
