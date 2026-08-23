import { useState, type FormEvent } from "react";
import { Download, Eye, Gauge, HardDrive, Play, RefreshCw, SearchX } from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  InlineNotice,
  PageHeader,
  SectionHeading,
  StatStrip,
  Toggle,
} from "../components";
import { formatBytesGb } from "../lib";
import type { LocalModel, RouterControlApi, RouterTarget, VisionEngine } from "../types";
import "./local-harness-context.css";

type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;

interface LocalPageProps {
  target?: RouterTarget;
  api?: RouterControlApi;
  refreshing: boolean;
  onRefresh: () => void;
  runAction: RunAction;
}

/** Local is intentionally a Vision-only surface. */
export function LocalPage({ target, api, refreshing, onRefresh, runAction }: LocalPageProps) {
  const [installRef, setInstallRef] = useState("");
  const [forceInstall, setForceInstall] = useState(false);
  const local = target?.modelSettings?.localModels;
  const bridge = target?.modelSettings?.visionBridge;
  const installed = local?.models?.filter((model) => model.installed !== false) ?? [];
  const installedCount = typeof local?.installed === "number" ? local.installed : installed.length;
  const enabledTags = Array.isArray(local?.enabled)
    ? local.enabled
    : installed.filter((model) => model.enabled === true).map((model) => model.tag);
  const localReaders = bridge?.localModels ?? local?.availableVision ?? [];
  const readerDownloadActive = bridge?.download?.status === "downloading";
  const engines: Array<VisionEngine & { group: string }> = [
    ...(bridge?.nativeEngines ?? []).map((engine) => ({ ...engine, group: "ChatGPT plan" })),
    ...(bridge?.paidEngines ?? []).map((engine) => ({ ...engine, group: "Connected provider" })),
  ];
  const selectedEngine = bridge?.engine || "auto";
  const selectedEngineMeta = engines.find((engine) => engine.slug === selectedEngine);
  const effortOptions = selectedEngineMeta?.efforts?.length
    ? selectedEngineMeta.efforts
    : bridge?.availableEfforts ?? [];

  async function installLocal(event: FormEvent) {
    event.preventDefault();
    const model = installRef.trim();
    if (!model || !api) return;
    setInstallRef("");
    await runAction(`Install Vision reader ${model}`, () => api.installLocalModel(model, forceInstall));
  }

  if (!target) {
    return <EmptyState icon={<SearchX size={22} />} title="Vision runtime unavailable" body="Start the router or refresh after setup completes." />;
  }

  return (
    <div className="local-page">
      <PageHeader
        eyebrow="On-device Vision"
        title="Vision readers"
        description="Install, measure, and pin local Ollama readers for pasted-image transcription. Local weights are never removed by the router."
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      <StatStrip items={[
        { label: "Runtime", value: local?.runtime?.running ? "Online" : "Offline", detail: local?.runtime?.version ? `Ollama ${local.runtime.version}` : "Ollama" },
        { label: "Installed", value: installedCount, detail: `${enabledTags.length} available to Vision` },
        { label: "Model storage", value: formatBytesGb(local?.totalGb), detail: local?.runtime?.modelsPath || "Location managed by Ollama" },
        { label: "Image reader", value: bridge?.engine === "local" ? "Local" : bridge?.resolvedEngineName || "Automatic", detail: bridge?.enabled ? "Bridge enabled" : "Bridge disabled" },
      ]} />

      <InlineNotice tone={local?.runtime?.running ? "success" : "warning"} title={local?.runtime?.running ? "Ollama is ready" : "Ollama is not running"}>
        {local?.machine || "Machine capacity has not been measured yet."}
      </InlineNotice>

      <div className="lhc-local-grid">
        <section className="panel-section lhc-local-installed">
          <SectionHeading
            title="Installed Vision weights"
            description="Installed models remain local inventory. Selecting one below only controls the Vision reader; it never adds a Codex chat route."
            action={
              <div className="row-actions">
                {!local?.runtime?.running ? (
                  <Button variant="ghost" disabled={!api} onClick={() => api && void runAction("Start local runtime", () => api.controlLocalRuntime("start"))}>
                    <Play aria-hidden size={13} strokeWidth={1.7} /> Start runtime
                  </Button>
                ) : null}
                {local?.runtime?.installed ? (
                  <Button variant="ghost" disabled={!api} onClick={() => api && void runAction("Update local runtime", () => api.controlLocalRuntime("update"))}>
                    <RefreshCw aria-hidden size={13} strokeWidth={1.7} /> Update Ollama
                  </Button>
                ) : null}
              </div>
            }
          />
          {installed.length ? (
            <div className="table-list">
              {installed.map((model) => (
                <InstalledVisionRow
                  key={model.tag}
                  model={model}
                  enabled={enabledTags.includes(model.tag) || model.enabled === true}
                  disabled={!api}
                  onToggle={(next) => api && void runAction(`${next ? "Make available" : "Hide"} ${model.tag} from Vision`, () => api.setLocalModelEnabled(model.tag, next))}
                  onBenchmark={() => api && void runAction(`Measure ${model.tag}`, () => api.benchmarkVisionModel(model.tag))}
                />
              ))}
            </div>
          ) : (
            <EmptyState icon={<HardDrive size={21} />} title="No local Vision weights installed" body="Install a reader below. Progress remains visible while the download runs." />
          )}
        </section>

        <section className="panel-section lhc-runtime-facts">
          <SectionHeading title="Runtime details" description="Read-only facts reported by the router and Ollama." />
          <dl>
            <div><dt>State</dt><dd>{local?.runtime?.running ? "Running" : local?.runtime?.installed ? "Stopped" : "Not installed"}</dd></div>
            <div><dt>Version</dt><dd>{local?.runtime?.version || "Not reported"}</dd></div>
            <div><dt>Managed</dt><dd>{local?.runtime?.managed ? "Router managed" : "External runtime"}</dd></div>
            <div><dt>Weights path</dt><dd title={local?.runtime?.modelsPath}>{local?.runtime?.modelsPath || "Ollama default"}</dd></div>
          </dl>
        </section>
      </div>

      <section className="panel-section">
        <SectionHeading title="Install a Vision reader" description="Enter an Ollama tag or an HTTPS ollama.com model page. Installing is explicit and does not publish a chat model." />
        <form className="install-form" onSubmit={(event) => void installLocal(event)}>
          <label htmlFor="local-model-ref">Model tag or Ollama URL</label>
          <div>
            <input id="local-model-ref" value={installRef} onChange={(event) => setInstallRef(event.target.value)} placeholder="qwen2.5vl:3b" spellCheck={false} />
            <Button variant="primary" disabled={!api || !installRef.trim()} type="submit"><Download aria-hidden size={14} strokeWidth={1.7} /> Install</Button>
          </div>
        </form>
        <label className="check-label install-override"><input type="checkbox" checked={forceInstall} onChange={(event) => setForceInstall(event.target.checked)} /> Allow a reader larger than the router recommends</label>
        {local?.download?.status && local.download.status !== "done" ? (
          <DownloadProgress tag={local.download.tag} percent={local.download.percent} detail={local.download.detail || local.download.status} />
        ) : null}
        {localReaders.length ? (
          <div className="lhc-local-quick-picks">
            <div className="lhc-local-subheading"><strong>Measured readers</strong><span>Vision-only shortlist</span></div>
            <div className="lhc-recommendations">
              {localReaders.slice(0, 8).map((reader) => (
                <button key={reader.tag} type="button" disabled={reader.downloadable === false} onClick={() => setInstallRef(reader.tag)}>
                  <Eye aria-hidden size={14} strokeWidth={1.7} />
                  <span><strong>{reader.displayName || reader.label || reader.tag}</strong><small>{formatBytesGb(reader.sizeGb)} · {reader.accuracy || "untested"}</small></span>
                  {reader.downloadable === false ? <Badge tone="neutral">Unavailable</Badge> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel-section">
        <SectionHeading title="Image reading" description="Choose how text-only models read pasted images. Local readers stay on this machine." />
        <div className="lhc-vision-settings">
          <div className="setting-row">
            <div><strong>Read pasted images</strong><small>The selected reader runs only when the target model cannot accept images.</small></div>
            <Toggle checked={bridge?.enabled === true} disabled={!api || !bridge} label="Enable vision bridge" onChange={(next) => api && void runAction(`${next ? "Enable" : "Disable"} vision bridge`, () => api.setVisionBridgeEnabled(next))} />
          </div>
          <div className="form-grid">
            <label>
              <span>Reader</span>
              <select value={selectedEngine} disabled={!api || !bridge} onChange={(event) => api && void runAction("Change image reader", () => api.setVisionBridgeEngine(event.target.value))}>
                <option value="auto">Automatic</option>
                {engines.filter((engine) => engine.group === "ChatGPT plan").length ? (
                  <optgroup label="ChatGPT plan">
                    {engines.filter((engine) => engine.group === "ChatGPT plan").map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                  </optgroup>
                ) : null}
                {engines.filter((engine) => engine.group === "Connected provider").length ? (
                  <optgroup label="Connected providers">
                    {engines.filter((engine) => engine.group === "Connected provider").map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                  </optgroup>
                ) : null}
                {bridge?.local ? <option value="local">Local: {bridge.local.model || "configured reader"}</option> : null}
              </select>
            </label>
            <label>
              <span>Reasoning effort</span>
              <select value={bridge?.effort || "default"} disabled={!api || !bridge} onChange={(event) => api && void runAction("Change image-reader effort", () => api.setVisionBridgeEffort(event.target.value))}>
                <option value="default">Reader default</option>
                {effortOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
          </div>
          <InlineNotice tone={bridge?.resolvedEngine ? "success" : "warning"} title={bridge?.resolvedEngine ? "Reader resolved" : "No reader available"}>
            {bridge?.resolvedEngineName ? `${bridge.resolvedEngineName} will transcribe images.` : "Connect a vision provider or install a local image reader."}
          </InlineNotice>
        </div>

        {readerDownloadActive ? <DownloadProgress tag={bridge?.download?.tag} percent={bridge?.download?.percent} detail={bridge?.download?.detail || "Downloading local reader"} /> : null}
        {localReaders.length ? (
          <div className="local-reader-grid lhc-reader-grid">
            {localReaders.map((reader) => {
              const active = bridge?.engine === "local" && bridge.local?.model === reader.tag;
              return (
                <article className="reader-card" key={reader.tag}>
                  <header>
                    <span className="model-glyph"><HardDrive aria-hidden size={14} strokeWidth={1.7} /></span>
                    <div><strong>{reader.label || reader.displayName || reader.tag}</strong><small>{formatBytesGb(reader.sizeGb)} · {reader.accuracy || "untested"}</small></div>
                    {active ? <Badge tone="success">In use</Badge> : null}
                  </header>
                  <p>{reader.note || "Local model for pasted-image transcription."}</p>
                  {reader.measured?.percent !== undefined ? <small className="reader-score">Reference score {Math.round(reader.measured.percent)}%{reader.measuredLocally ? " · measured here" : ""}</small> : null}
                  <footer>
                    {reader.installed ? (
                      <>
                        <Button variant="ghost" disabled={!api || active} onClick={() => api && void runAction(`Use ${reader.tag} as image reader`, () => api.useLocalVisionModel(reader.tag))}><Eye aria-hidden size={13} strokeWidth={1.7} /> {active ? "In use" : "Use reader"}</Button>
                        <Button variant="ghost" disabled={!api} onClick={() => api && void runAction(`Measure ${reader.tag}`, () => api.benchmarkVisionModel(reader.tag))}><Gauge aria-hidden size={13} strokeWidth={1.7} /> Measure</Button>
                      </>
                    ) : (
                      <Button variant="secondary" disabled={!api || readerDownloadActive || reader.fits === false} onClick={() => api && void runAction(`Download ${reader.tag}`, () => api.downloadVisionModel(reader.tag))}><Download aria-hidden size={13} strokeWidth={1.7} /> Download</Button>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
        ) : <EmptyState title="No local image readers listed" body="Refresh after Ollama and the local Vision catalog are available." />}
      </section>
    </div>
  );
}

function DownloadProgress({ tag, percent, detail }: { tag?: string; percent?: number; detail?: string }) {
  return (
    <div className="download-progress">
      <div><strong>{tag || "Vision reader"}</strong><span>{Math.round(percent || 0)}%</span></div>
      <progress max="100" value={percent || 0} />
      <small>{detail || "Preparing download"}</small>
    </div>
  );
}

function InstalledVisionRow({ model, enabled, disabled, onToggle, onBenchmark }: {
  model: LocalModel;
  enabled: boolean;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onBenchmark: () => void;
}) {
  return (
    <article className="local-model-row">
      <div className="model-identity">
        <span className="model-glyph"><HardDrive aria-hidden size={15} strokeWidth={1.7} /></span>
        <div><strong>{model.displayName || model.label || model.tag}</strong><small>{model.tag}</small></div>
      </div>
      <div className="local-model-facts">
        <span>{formatBytesGb(model.sizeGb)}</span>
        <span>{model.vision ? "Image input" : "Text-only"}</span>
        <span>{model.running ? "Loaded" : "Not loaded"}</span>
      </div>
      <div className="row-actions">
        <Button variant="ghost" disabled={disabled || !model.vision} onClick={onBenchmark}><Gauge aria-hidden size={14} strokeWidth={1.7} /> Measure</Button>
        <Toggle checked={enabled} disabled={disabled || !model.vision} label={`Make ${model.tag} available to Vision`} onChange={onToggle} />
      </div>
    </article>
  );
}
