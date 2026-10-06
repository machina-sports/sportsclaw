<script setup lang="ts">
/* How sportsclaw sits inside a Machina project. Mirrors what the platform
   provisions per project (machina-core-api, core/tenant_project): a relay
   Deployment running this engine + sports-skills + a memory volume, wired to
   the project's MCP server over SSE with the project token. */
</script>

<template>
  <figure class="sc-arch" aria-label="sportsclaw inside a Machina project">
    <div class="sc-arch-callers">
      <span class="sc-arch-kicker">Callers</span>
      <ul>
        <li>Factory app builder</li>
        <li>Broadcast &amp; studio desks</li>
        <li>Project connectors &amp; workflows</li>
        <li>Your own services</li>
      </ul>
    </div>

    <div class="sc-arch-wire" aria-hidden="true">
      <span>authenticated HTTP · <code>/api/query</code> · <code>/api/capabilities</code> · <code>/api/decide</code></span>
    </div>

    <div class="sc-arch-project">
      <div class="sc-arch-project-head">
        <svg viewBox="410 585 410 410" aria-hidden="true"><path d="M665.563 848.628L616.071 957.021C604.22 982.974 567.122 982.974 562.613 957.021L543.781 848.628C543.711 848.228 543.445 847.911 543.064 847.774L439.494 810.597C415.552 802.003 420.534 766.775 446.907 758.181L560.993 721.004C561.413 720.868 561.769 720.551 561.951 720.15L611.444 611.757C623.294 585.804 660.392 585.804 664.901 611.757L683.734 720.15C683.804 720.551 684.07 720.868 684.451 721.004L788.021 758.181C811.963 766.775 806.981 802.003 780.608 810.597L666.522 847.774C666.102 847.911 665.746 848.228 665.563 848.628Z" /></svg>
        <span>Machina project</span>
        <em>isolated tenant · provisioned per project</em>
      </div>
      <div class="sc-arch-core">
        <div class="sc-arch-box is-claw">
          <span class="sc-arch-tag">sportsclaw relay</span>
          <strong>The same open-source engine</strong>
          <ul>
            <li>sportsclaw engine (TypeScript)</li>
            <li>sports-skills data layer · 17 default skills</li>
            <li>memory volume · per-user agent memory</li>
          </ul>
        </div>
        <div class="sc-arch-link" aria-hidden="true">
          <span class="sc-arch-link-line" />
          <span class="sc-arch-link-label">MCP · SSE<br />project token</span>
        </div>
        <div class="sc-arch-box is-machina">
          <span class="sc-arch-tag">project MCP server</span>
          <strong>Everything the project owns</strong>
          <ul>
            <li>licensed feeds via connectors</li>
            <li>documents, workflows, agents</li>
            <li>durable loop, when loop-runner is installed</li>
          </ul>
        </div>
      </div>
      <p class="sc-arch-siblings">alongside the project's Client API, workers, Redis and vault</p>
    </div>

    <div class="sc-arch-sources">
      <div class="sc-arch-source">
        <span class="sc-arch-kicker">Keyless public data</span>
        <p>ESPN · FastF1 · Kalshi · Polymarket · news</p>
      </div>
      <div class="sc-arch-source is-machina">
        <span class="sc-arch-kicker">Licensed &amp; project data</span>
        <p>real-time feeds, odds, the project's own documents</p>
      </div>
    </div>

    <figcaption>
      Outside-in works too: any sportsclaw install can join the same project with
      <code>sportsclaw machina connect</code>, which mints a durable service key through machina-cli.
    </figcaption>
  </figure>
</template>

<style scoped>
.sc-arch {
  margin: 0;
  display: grid;
  gap: 0;
  font-size: 14px;
}
.sc-arch-kicker {
  display: block;
  font-family: var(--sc-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sc-text-3);
}
.sc-arch code {
  font-family: var(--sc-mono);
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--sc-surface-3);
  color: var(--sc-text);
}

/* Callers */
.sc-arch-callers {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  padding: 14px 16px;
  border: 1px dashed var(--sc-line-2);
  border-radius: var(--sc-r);
}
.sc-arch-callers ul {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.sc-arch-callers li {
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--sc-line-2);
  background: var(--sc-surface);
  color: var(--sc-text-2);
  font-size: 13px;
}

/* Vertical wire with a label */
.sc-arch-wire {
  position: relative;
  display: flex;
  justify-content: center;
  padding: 26px 0;
}
.sc-arch-wire::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  background: linear-gradient(var(--sc-line-2), var(--sc-claw));
}
.sc-arch-wire::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: calc(50% - 4px);
  border: 4px solid transparent;
  border-top: 6px solid var(--sc-claw);
  border-bottom: 0;
}
.sc-arch-wire span {
  position: relative;
  max-width: 100%;
  padding: 4px 10px;
  border-radius: 8px;
  background: var(--sc-bg);
  border: 1px solid var(--sc-line);
  color: var(--sc-text-3);
  font-size: 12.5px;
  text-align: center;
}

/* The project */
.sc-arch-project {
  position: relative;
  padding: 16px;
  border-radius: var(--sc-r-lg);
  border: 1px solid color-mix(in srgb, var(--sc-machina-fill) 38%, var(--sc-line));
  background:
    radial-gradient(120% 80% at 100% 0%, var(--sc-machina-a), transparent 60%),
    var(--sc-surface);
}
.sc-arch-project-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  margin-bottom: 14px;
}
.sc-arch-project-head svg {
  width: 15px;
  height: 15px;
  fill: var(--sc-machina-fill);
  align-self: center;
}
.sc-arch-project-head span {
  font-weight: 600;
  color: var(--sc-text);
}
.sc-arch-project-head em {
  font-style: normal;
  font-family: var(--sc-mono);
  font-size: 12px;
  color: var(--sc-text-3);
}
.sc-arch-core {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 96px minmax(0, 1fr);
  align-items: stretch;
}
.sc-arch-box {
  padding: 14px 16px;
  border-radius: var(--sc-r);
  border: 1px solid var(--sc-line-2);
  background: var(--sc-bg);
}
.sc-arch-box.is-claw {
  border-color: color-mix(in srgb, var(--sc-volt) 45%, var(--sc-line));
  box-shadow: 0 0 0 4px var(--sc-claw-a);
}
.sc-arch-tag {
  display: inline-block;
  margin-bottom: 8px;
  padding: 1px 8px;
  border-radius: 6px;
  font-family: var(--sc-mono);
  font-size: 11.5px;
  color: var(--sc-claw);
  background: var(--sc-claw-a);
}
.sc-arch-box.is-machina .sc-arch-tag {
  color: var(--sc-machina);
  background: var(--sc-machina-a);
}
.sc-arch-box strong {
  display: block;
  margin-bottom: 6px;
  font-size: 15px;
  color: var(--sc-text);
}
.sc-arch-box ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 4px;
}
.sc-arch-box li {
  position: relative;
  padding-left: 14px;
  color: var(--sc-text-2);
  font-size: 13.5px;
  line-height: 1.5;
}
.sc-arch-box li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 0.62em;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--sc-text-3);
}
.sc-arch-link {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sc-arch-link-line {
  position: absolute;
  left: 6px;
  right: 6px;
  top: calc(50% - 1px);
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--sc-volt), var(--sc-machina-fill));
}
.sc-arch-link-line::before,
.sc-arch-link-line::after {
  content: '';
  position: absolute;
  top: -3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.sc-arch-link-line::before {
  left: -3px;
  background: var(--sc-volt);
}
.sc-arch-link-line::after {
  right: -3px;
  background: var(--sc-machina-fill);
}
.sc-arch-link-label {
  position: relative;
  padding: 3px 6px;
  border-radius: 6px;
  background: var(--sc-surface);
  font-family: var(--sc-mono);
  font-size: 10.5px;
  line-height: 1.35;
  text-align: center;
  color: var(--sc-text-3);
}
.sc-arch-siblings {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: var(--sc-text-3);
}

/* Sources */
.sc-arch-sources {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 12px;
}
.sc-arch-source {
  padding: 12px 16px;
  border-radius: var(--sc-r);
  border: 1px solid var(--sc-line);
  border-top: 2px solid var(--sc-volt);
  background: var(--sc-surface);
}
.sc-arch-source.is-machina {
  border-top-color: var(--sc-machina-fill);
}
.sc-arch-source p {
  margin: 4px 0 0;
  color: var(--sc-text-2);
  font-size: 13.5px;
  line-height: 1.5;
}
.sc-arch figcaption {
  margin-top: 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--sc-text-3);
}

@media (max-width: 720px) {
  .sc-arch-core {
    grid-template-columns: minmax(0, 1fr);
  }
  .sc-arch-link {
    height: 64px;
  }
  .sc-arch-link-line {
    left: 50%;
    right: auto;
    top: 6px;
    bottom: 6px;
    width: 2px;
    height: auto;
    background: linear-gradient(var(--sc-volt), var(--sc-machina-fill));
  }
  .sc-arch-link-line::before {
    left: -3px;
    top: -3px;
  }
  .sc-arch-link-line::after {
    left: -3px;
    right: auto;
    top: auto;
    bottom: -3px;
  }
  .sc-arch-sources {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
