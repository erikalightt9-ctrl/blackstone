export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'AppError'; this.status = status; }
}
export function permit(actor, roles) {
  if (!actor || !roles.includes(actor.role)) throw new AppError('You do not have permission for this action.', 403);
}
export function found(value, what = 'Record') {
  if (!value) throw new AppError(`${what} not found.`, 404);
  return value;
}
