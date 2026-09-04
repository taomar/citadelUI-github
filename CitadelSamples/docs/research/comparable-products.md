# Comparable executable playgrounds

Research date and source access date: **2026-09-04**

## Decision

Keep the existing Citadel catalogue and executor as the product authority, and
give them a notebook-like presentation. Do not make a general-purpose notebook
editor or shell the user experience.

Citadel's target is narrower than notebook authoring:

1. show the fixed sample source and its provenance;
2. let the user edit only declared parameters, configuration, and secrets;
3. show the exact redacted plan;
4. require explicit approval where risk demands it;
5. execute only the server's known sample implementation; and
6. stream evidence, outputs, and generated artifacts without accepting user code.

That is already the architectural direction of the playground. Its browser sends
only a sample ID, declared values, transient declared secrets, and an
acknowledgement. The server validates those values and rebuilds typed,
allowlisted `artifact`, `azure-cli`, `http`, `library`, and `assertion` steps.
Secrets remain out of plans and exports, risky runs spend a fresh
acknowledgement, cancellation targets a run ID, and generated files stay inside
the run workspace. A notebook editor would weaken those properties unless most
of its authoring and terminal surface were removed.

The strongest product lesson is therefore **not to adopt a notebook product**.
It is to render Citadel's immutable catalogue steps as familiar notebook-like
cells around the existing Configure, Request, approval, run, and Response
contract.

## Comparison at a glance

| Product | What is verified and useful | Fixed visible source with declared inputs only | Azure CLI and isolation | Fit |
| --- | --- | --- | --- | --- |
| JupyterLab / Notebook | Mature cell UX, kernels, rich output, interrupt/restart, terminals, extensions, notebook trust | Source is an editing surface. Trust controls unsafe output rendering, not source immutability. A read-only UI or metadata convention is not an execution security boundary. | A JupyterLab terminal is a full system shell with the server user's privileges. Isolation is supplied by the deployment, not the notebook. | Excellent authoring environment; wrong end-user authority model. |
| JupyterLite / Pyodide | Static deployment, browser kernels, browser storage, service-worker offline caching | Still an authoring notebook unless customized. Browser-only presentation does not make a client-supplied program trustworthy. | Pyodide packages run in WebAssembly in the browser; it cannot provide the installed system Azure CLI and server-side Azure identity boundary these samples need. | Good zero-install educational demo; not a Citadel execution runtime. |
| VS Code notebooks | Strong editing, debugging, kernels, output renderers, Git diff, accessibility, local/remote development | Official documentation exposes editable cells and workspace trust, not an enforceable per-cell parameter-only product mode. | Full integrated terminal. Azure CLI works when installed in the selected local or remote environment. | Use for contributors, not playground users. |
| GitHub Codespaces | Reproducible dev containers, isolated VM per codespace, browser VS Code, ports, persistent workspace | Repository and editor remain user-authoring surfaces; no Codespaces-specific fixed-cell protection was found. | Strong development isolation, but users generally control the container and terminal. Internet and metered hosted compute are required. | Useful maintainer environment; too broad and costly as the product shell. |
| Azure Machine Learning notebooks | Managed compute, Azure CLI, custom kernels, terminals, RBAC, jobs, logs/artifacts, cancellation, private networking | Reader/Contributor access is notebook-level. No native declared-input-only, protected-cell flow was found. | Strong Azure runtime and network controls, but a compute instance is a code-first, single-user development workstation with broad privileges. | Possible infrastructure reference; heavyweight and mismatched as UI. |
| marimo | Reactive Python, typed UI elements, deterministic dependency graph, `.py` source, app mode, static/WASM export | `marimo run` removes the editor and hides code by default; code can be included for display. This is the closest presentation model, but it does not supply Citadel's plan allowlist or approval boundary. | Server apps execute the notebook's Python authority; WASM exports cannot replace server-side Azure CLI/identity. | Best interaction reference; do not replace the executor with it. |
| Observable notebooks / Framework | Excellent reactive inputs, immediate output, sharing, and static data-app deployment | Hosted notebooks are authoring/collaboration products. Framework can publish a non-authoring site, but it is a JavaScript/data-app build system rather than a protected Azure run contract. | No first-class Azure CLI or controlled server job boundary in the notebook model. | Borrow reactive input/output polish, not the platform. |
| Runme | Makes Markdown command blocks visible and runnable; terminal, CLI, environment metadata, cloud-native workflow focus | Its purpose is executable operational documentation. Commands remain authorable and its shell kernel is broader than Citadel's declared operations. | Full shell/CLI access is a feature, not something Runme is designed to remove. | Good command-preview precedent; unacceptable end-user authority. |
| Papermill | Injects declared parameter values, executes a notebook, and writes an output notebook | Parameters are a tagged code cell and execution injects another code cell. It is a batch tool, not a protected form, review, or approval UI. | Runs the notebook kernel with the worker's authority; isolation belongs to the orchestrator. | Borrow parameter/run provenance concepts only. |
| Voilà | Serves notebooks as apps, hides code by default, supports widgets, creates a kernel for a viewed notebook | It removes notebook editing from the viewer, but its default is hidden code rather than protected visible code. Showing source, typed configuration, approval, and a safe plan would still be custom work. | Each app has access to an underlying Jupyter kernel. The deployment must constrain that arbitrary notebook process. | Closest Jupyter viewer, but adds a kernel stack without removing Citadel custom work. |
| Streamlit | Fixed server-side Python app, forms, status elements, downloads, broad deployment choices | End users do not edit the app source, but source is not a first-class visible/provenance-bearing cell surface. | Python process authority and isolation are deployment concerns; no Citadel operation allowlist is provided. | Useful adjacent app benchmark, not a notebook or execution contract. |

## Findings by concern

### Protected source and trust

**Verified facts**

- JupyterLab explicitly has Edit and Command modes and supports creating,
  editing, moving, copying, and deleting cells. Its trust model sanitizes HTML
  and JavaScript output from untrusted notebooks; rerunning a cell trusts its
  output. Trust does not claim to lock source
  ([JupyterLab notebooks](https://jupyterlab.readthedocs.io/en/stable/user/notebook.html);
  [Jupyter Server security model](https://jupyter-server.readthedocs.io/en/stable/operators/security.html#our-security-model)).
- VS Code notebooks expose ordinary editable code and Markdown cells.
  Workspace Trust disables notebook execution and hides rich output in
  Restricted Mode, but it is a workspace safety feature rather than a per-cell
  lock
  ([Jupyter Notebooks in VS Code](https://code.visualstudio.com/docs/datascience/jupyter-notebooks);
  [Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust)).
- Azure Machine Learning uses workspace/RBAC permissions: a Reader can view and
  a Contributor can edit. The reviewed documentation does not describe a
  protected-code-plus-editable-parameters cell policy
  ([Run Jupyter notebooks in your workspace](https://learn.microsoft.com/en-us/azure/machine-learning/how-to-run-jupyter-notebooks?view=azureml-api-2);
  [Manage workspace files](https://learn.microsoft.com/en-us/azure/machine-learning/how-to-manage-files?view=azureml-api-2)).
- marimo's application mode runs without its editor, hides code by default, and
  can include code in the app view
  ([Run as an app](https://docs.marimo.io/guides/apps/)).
- Voilà executes a notebook and converts it to HTML with code cells hidden by
  default; widgets retain access to the kernel
  ([Using Voilà](https://voila.readthedocs.io/en/stable/using.html)).

**Inference for Citadel**

Code protection must be enforced at the request and executor boundary, not by a
disabled editor control, hidden cell, notebook trust flag, or file permission.
The client must remain unable to submit source, commands, URLs, headers,
executables, or paths. A visible code block should be a rendering of the
catalogue-owned step plus its source-cell citation and digest.

### Parameters and forms

**Verified facts**

- Jupyter widgets can provide interactive controls, but they are code-driven
  outputs rather than a native product-wide declared-input contract
  ([Jupyter widgets](https://ipywidgets.readthedocs.io/en/stable/examples/Widget%20Basics.html)).
- Papermill tags one cell `parameters`, injects overridden values in a new
  `injected-parameters` cell, and then executes the notebook
  ([Papermill parameterize](https://papermill.readthedocs.io/en/latest/usage-parameterize.html)).
- marimo provides reactive UI elements and forms, and app mode exposes outputs
  without the editor
  ([marimo UI inputs](https://docs.marimo.io/guides/interactivity/);
  [marimo forms](https://docs.marimo.io/api/inputs/form/)).
- Observable Inputs provide reactive controls for JavaScript notebooks and data
  apps
  ([Observable Inputs](https://observablehq.com/framework/lib/inputs)).
- Streamlit forms batch widget values until submission
  ([`st.form`](https://docs.streamlit.io/develop/api-reference/execution-flow/st.form)).

**Inference for Citadel**

Papermill's separation of defaults from injected run values is useful for run
provenance. marimo and Observable are stronger references for responsive form
behavior. Citadel should keep its own field classification -- mandatory,
conditional, optional/defaulted, generated/override, and secret -- because none
of the evaluated products provides that domain contract together with
server-side reconstruction and risk approval.

### Kernels, terminals, Azure CLI, and isolation

**Verified facts**

- JupyterLab terminals are full system shells running where the Jupyter server
  runs, with the user's privileges
  ([JupyterLab terminals](https://jupyterlab.readthedocs.io/en/stable/user/terminal.html)).
- VS Code provides an integrated system terminal
  ([Terminal basics](https://code.visualstudio.com/docs/terminal/basics)).
- A codespace is a Linux dev container on a GitHub-hosted VM; each codespace
  receives a newly built VM and isolated network, but the user controls the
  development environment
  ([What are GitHub Codespaces?](https://docs.github.com/en/codespaces/about-codespaces/what-are-codespaces);
  [Codespaces security](https://docs.github.com/en/codespaces/reference/security-in-github-codespaces)).
- Azure Machine Learning compute instances include terminals, Azure CLI, custom
  kernels, and managed-identity login support
  ([Azure ML compute instances](https://learn.microsoft.com/en-us/azure/machine-learning/concept-compute-instance?view=azureml-api-2);
  [Access a compute terminal](https://learn.microsoft.com/en-us/azure/machine-learning/how-to-access-terminal?view=azureml-api-2)).
- JupyterLite runs kernels in the browser. Its Pyodide kernel installs compatible
  packages through `piplite`/`micropip`, while service workers can cache the app,
  content, packages, and kernel requests for offline use
  ([JupyterLite Pyodide packages](https://jupyterlite.readthedocs.io/en/stable/howto/pyodide/packages.html);
  [JupyterLite ServiceWorker](https://jupyterlite.readthedocs.io/en/stable/howto/configure/advanced/service-worker.html);
  [Pyodide WebAssembly constraints](https://pyodide.org/en/stable/usage/wasm-constraints.html)).

**Inference for Citadel**

Do not expose a terminal. Azure CLI should remain an implementation detail of a
trusted local operator process or a per-run hosted worker. A hosted worker should
receive a server-built operation and short-lived identity, not user-authored
shell text. JupyterLite cannot run the current Azure management samples
faithfully and would move sensitive configuration and execution authority into
the browser.

### Output, artifacts, cancellation, and sharing

**Verified facts**

- Jupyter and VS Code stream kernel output into cells and expose interrupt and
  restart controls; this is a live kernel session, not automatically a durable
  job record
  ([Jupyter messaging](https://jupyter-client.readthedocs.io/en/stable/messaging.html);
  [Jupyter notebooks in VS Code](https://code.visualstudio.com/docs/datascience/jupyter-notebooks)).
- Azure Machine Learning jobs retain job history, outputs, and logs and can be
  cancelled independently of an interactive notebook
  ([Monitor and analyze jobs](https://learn.microsoft.com/en-us/azure/machine-learning/how-to-track-monitor-analyze-runs?view=azureml-api-2)).
- Papermill writes a separate executed output notebook and supports pluggable
  storage
  ([Papermill execute](https://papermill.readthedocs.io/en/latest/usage-execute.html);
  [Papermill store](https://papermill.readthedocs.io/en/latest/usage-store.html)).
- Codespaces persists repository workspace files across stop/start and can
  reproduce tooling through `devcontainer.json`
  ([Codespaces lifecycle](https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle);
  [Dev containers](https://docs.github.com/en/codespaces/setting-up-your-project-for-codespaces/adding-a-dev-container-configuration/introduction-to-dev-containers)).

**Applicable gap in the current playground**

The local `/api/run` response exposes a run ID in headers and supports
cancellation, but returns the final JSON body after execution rather than a
progressive event stream. Local active state is process-memory state. Generated
files are listed under `.runs/{run-id}/`, while configuration exports are
downloadable and redacted; there is not yet a durable, shareable, redacted run
record.

The redesign should add:

- server-sent or polled step state keyed by run ID;
- exact-run cancellation and explicit partial/cancelled outcomes;
- downloadable generated artifacts through contained, authorized paths;
- a redacted run manifest containing source notebook hash, sample ID, catalogue
  version, public input manifest, plan digest, runtime/adapter version, step
  states, assertions, and artifact digests; and
- no secret values, tokens, authorization headers, or secret-bearing arguments
  in that record.

This borrows Jupyter's progressive cell feedback, Papermill's input/output run
provenance, and Azure ML's durable job model without adopting their arbitrary
kernel authority.

### Deployment, offline use, accessibility, and maintenance

| Product family | Deployment and offline facts | Accessibility and licensing implications |
| --- | --- | --- |
| JupyterLab / Notebook | Local or hosted Jupyter Server; broad extension system. Local use can be offline once dependencies are installed. | JupyterLab documents keyboard and screen-reader support. JupyterLab is BSD-3-Clause. A self-hosted adoption would also own the server, kernel, extension, and vulnerability-update chain. ([Accessibility](https://jupyterlab.readthedocs.io/en/stable/user/accessibility.html); [license](https://github.com/jupyterlab/jupyterlab/blob/main/LICENSE)) |
| JupyterLite / Pyodide | Static-site deployment and service-worker caching are strong offline options, subject to browser and HTTPS/loopback requirements. | Inherits much of the JupyterLab frontend, but browser kernels and extensions add a distinct compatibility matrix. JupyterLite is BSD-3-Clause; Pyodide is MPL-2.0. ([JupyterLite repo](https://github.com/jupyterlite/jupyterlite); [Pyodide license](https://github.com/pyodide/pyodide/blob/main/LICENSE)) |
| VS Code / Codespaces | VS Code desktop supports local/offline kernels. Codespaces requires connectivity and metered compute/storage; its terms restrict production hosting and resale as an integrated service. | VS Code has detailed notebook/terminal accessibility guidance. Code-OSS and the Jupyter extension are MIT; Microsoft's distribution, Marketplace, and Codespaces have separate terms. ([Accessibility](https://code.visualstudio.com/docs/configure/accessibility/accessibility); [Codespaces billing](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces); [additional product terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)) |
| Azure Machine Learning | Managed cloud workspace and compute; no first-party offline AML notebook service. Compute, disk, network, and related resources incur Azure charges. | Studio notebooks document keyboard commands, but an AML-notebook-specific conformance report was not located. Jupyter components remain OSS and Microsoft states they are outside Microsoft Support. ([Run notebooks](https://learn.microsoft.com/en-us/azure/machine-learning/how-to-run-jupyter-notebooks?view=azureml-api-2); [manage compute](https://learn.microsoft.com/en-us/azure/machine-learning/how-to-manage-compute-instance?view=azureml-api-2)) |
| marimo | Local server, hosted app, static HTML, or WebAssembly HTML. WASM can preserve interactive controls in-browser. | Apache-2.0. The official documentation describes keyboard controls, but no product-specific WCAG conformance claim was located; Citadel still needs its own WCAG 2.2 AA testing. ([Apps](https://docs.marimo.io/guides/apps/); [license](https://github.com/marimo-team/marimo/blob/main/LICENSE)) |
| Observable | Hosted notebooks and statically built Framework sites have different product and licensing boundaries. Framework supports local preview and static deployment. | Observable Framework is ISC-licensed; hosted Observable is a service under separate terms. No notebook-specific conformance claim sufficient for Citadel acceptance was located. ([Framework](https://observablehq.com/framework/); [Framework license](https://github.com/observablehq/framework/blob/main/LICENSE); [terms](https://observablehq.com/terms-of-service/)) |
| Runme | Local CLI and VS Code notebook extension; Markdown remains portable. | Apache-2.0. VS Code supplies much of the editor accessibility surface; no independent Runme conformance claim was located. ([Runme docs](https://docs.runme.dev/); [license](https://github.com/runmedev/runme/blob/main/LICENSE)) |
| Papermill / Voilà | Local or hosted Python/Jupyter deployment. Papermill is headless; Voilà is a server app or Jupyter server extension. | Both are BSD-3-Clause. A Voilà adoption inherits Jupyter kernels, widgets, templates, and their maintenance/security surface. Neither removes the need to validate Citadel's own UI against WCAG 2.2 AA. ([Papermill license](https://github.com/nteract/papermill/blob/main/LICENSE); [Voilà license](https://github.com/voila-dashboards/voila/blob/main/LICENSE)) |
| Streamlit | Local Python server or hosted deployment; not an offline browser runtime. | Apache-2.0. It would add an application framework while still requiring custom source/provenance and execution-policy UI. ([Architecture](https://docs.streamlit.io/develop/concepts/architecture/architecture); [license](https://github.com/streamlit/streamlit/blob/develop/LICENSE)) |

Maintenance strength does not reverse the product decision. Jupyter, VS Code,
Azure ML, and the other evaluated projects have maintained documentation and
substantial ecosystems, but those ecosystems optimize for authoring arbitrary
programs or deploying general apps. Citadel would still need custom controls for
source protection, typed declared inputs, secret handling, plan review,
per-run approval, operation allowlisting, and evidence semantics. Adopting their
runtime or editor would add dependencies and attack surface without replacing
that work.

## Recommended product shape

1. **Notebook-like, not a notebook editor.** Render a linear sequence of
   narrative, immutable source, declared input, approval, execution, and output
   cells. Keep source selectable and copyable, but not editable or executable
   independently.
2. **One execution authority.** Continue rebuilding the selected sample from the
   server catalogue. Treat any future client-supplied source, command, URL,
   executable, path, or header as invalid input.
3. **Inputs beside the code that consumes them.** Reuse the current typed field
   definitions and secret store. A visual parameter cell is only a view over
   that schema, never executable source.
4. **Review before effects.** Preserve the exact redacted plan and fresh
   acknowledgement. Show risk, target, identities, and generated artifacts
   immediately before Run.
5. **No general terminal.** Local mode may call installed `az` and Python through
   existing registries. Hosted mode should use an isolated per-run worker with
   managed identity and Key Vault, destination allowlists, concurrency and
   timeout limits, and no browser-supplied operations.
6. **Progressive and durable evidence.** Add run polling or events, artifact
   retrieval, and a redacted reproducibility manifest. Keep blocked, failed,
   inconclusive, cancelled, and completed distinct.
7. **Two honest availability modes.** Keep a fully local/offline preview and
   self-test. Label Azure execution as requiring either the trusted local
   operator runtime or the hosted isolated executor; do not emulate a passing
   Azure run in JupyterLite/Pyodide.
8. **Accessibility remains a release gate.** Retain the current semantic forms,
   keyboard tab behavior, live announcements, reduced motion, zoom, and narrow
   viewport support. Complete the planned Firefox, Safari, and real
   NVDA/JAWS/VoiceOver validation rather than assuming framework inheritance.

## Why the maintained notebook products were not selected

They solve a different trust problem. A notebook grants a kernel authority to
source the user can normally edit. Citadel must grant a narrowly scoped executor
authority to source the product owns while users provide only declared data.

- JupyterLab, VS Code, Codespaces, Azure ML, and Runme expose editing and/or a
  terminal by design.
- JupyterLite has attractive offline distribution but cannot faithfully host
  the Azure CLI, managed identity, and native/server dependencies.
- Papermill improves repeatable parameterized batch execution but supplies no
  protected user experience or approval policy.
- Voilà and marimo app mode come closest to a non-authoring presentation, but
  would still require Citadel-specific visible-source, schema, plan, approval,
  secret, allowlist, and evidence layers.
- Observable, marimo, and Streamlit provide excellent interaction ideas, but
  changing application framework would not improve the core execution trust
  boundary.

The lowest-risk and lowest-duplication path is therefore to extend the code that
already encodes Citadel's domain and safety rules, while borrowing the best
notebook interaction patterns rather than a notebook runtime.
