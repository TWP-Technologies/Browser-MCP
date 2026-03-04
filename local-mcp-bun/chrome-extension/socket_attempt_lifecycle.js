// Modified by [KnotFalse]

export class socket_attempt_lifecycle {
  constructor() {
    this.active_generation = null;
  }

  begin(generation) {
    this.active_generation = generation;
  }

  claim_terminal(generation) {
    if (this.active_generation !== generation) {
      return false;
    }

    this.active_generation = null;
    return true;
  }

  clear() {
    this.active_generation = null;
  }

  get_active_generation() {
    return this.active_generation;
  }
}
