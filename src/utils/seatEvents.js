const EventEmitter = require('events');

const seatEvents = new EventEmitter();
// Allow multiple concurrent browser connections
seatEvents.setMaxListeners(200);

/**
 * Broadcast real-time seat update to all connected SSE clients
 *
 * @param {number} eventId
 * @param {object} payload - { type: 'SEAT_UPDATE', seatIds: Array, state: 'HELD'|'BOOKED'|'AVAILABLE'|'BLOCKED', studentId }
 */
function broadcastSeatUpdate(eventId, payload) {
  try {
    seatEvents.emit(`seat-update:${eventId}`, payload);
  } catch (err) {
    console.error('Error broadcasting SSE seat update:', err);
  }
}

module.exports = {
  seatEvents,
  broadcastSeatUpdate,
};
