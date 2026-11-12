export class DomainError extends Error {
  constructor(message, code='INVALID_INPUT') { super(message); this.name='DomainError'; this.code=code; }
}
export function requireRule(condition,message,code) { if(!condition) throw new DomainError(message,code); }
