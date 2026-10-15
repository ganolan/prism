// Errors from the linked-quiz services. `code` drives the HTTP status in
// server/routes/quizzes.js and the MCP tool error text:
// NOT_FOUND, NOT_ELIGIBLE, PARITY, NO_SESSION, UNREACHABLE (Schoology could not be
// reached: not an expired session), BUSY.
export class QuizError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
