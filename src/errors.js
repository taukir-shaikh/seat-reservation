// An error we expect and want to show to the client as-is (4xx).
class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// A clean "no" to a reservation: seat taken, over the limit, ...
// Always 409. `reason` is also the metrics label.
class Decline extends HttpError {
  constructor(reason, message, extra) {
    super(409, reason, message, extra);
    this.reason = reason;
  }
}

module.exports = { HttpError, Decline };
