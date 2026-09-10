import { configurationKey, configurationOf } from '../../shared/workspace-configuration.mjs';

export class WorkspaceViewState {
  constructor(createState) {
    this.createState = createState;
    this.views = new Map();
    this.current = null;
    this.generation = 0;
  }

  activate(context) {
    const key = `${context.environment.id}:${configurationKey(configurationOf(context.environment))}`;
    if (!this.views.has(key)) this.views.set(key, this.createState());
    this.current = { key, state: this.views.get(key), environmentId: context.environment.id };
    this.current.state.workspaceId = context.environment.id;
    this.generation += 1;
    return this.current.state;
  }

  leave() { this.current = null; this.generation += 1; }
  ticket() { return { key: this.current?.key || null, generation: this.generation }; }
  isCurrent(ticket) { return Boolean(this.current && ticket?.key === this.current.key && ticket.generation === this.generation); }
}
