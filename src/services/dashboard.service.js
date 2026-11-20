const db = require('../config/db');

/**
 * Service to calculate real-time ticket sales, capacity, and remaining inventory.
 * Enforces server-side ADMIN authorization check.
 *
 * @param {object} currentUser - Must have ADMIN role
 * @returns {Promise<object>} Sales dashboard metrics, event breakdowns, and recent sales
 */
async function getAdminSalesDashboard(currentUser) {
  // 1. Service-layer authorization check
  if (!currentUser || currentUser.role !== 'ADMIN') {
    const error = new Error('Access denied: Sales Dashboard requires ADMIN role');
    error.statusCode = 403;
    throw error;
  }

  // 2. Query per-event inventory and sales breakdown
  const eventsSql = `
    SELECT 
      e.id,
      e.title,
      e.theme_photo,
      e.venue,
      e.start_time,
      e.end_time,
      e.is_published,
      e.version,
      u.name as organizer_name,
      u.email as organizer_email,
      COUNT(DISTINCT s.id)::int as total_seats,
      COUNT(DISTINCT bs.id) FILTER (WHERE bs.status = 'CONFIRMED' AND b.status = 'CONFIRMED')::int as booked_seats,
      COUNT(DISTINCT hs.id) FILTER (WHERE h.status = 'ACTIVE' AND h.expires_at > NOW())::int as held_seats,
      COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'BLOCKED')::int as blocked_seats,
      COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'CONFIRMED')::int as confirmed_bookings_count,
      COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'CONFIRMED' AND b.checked_in = true)::int as checked_in_count,
      COALESCE((SELECT COUNT(*) FROM waitlist w WHERE w.event_id = e.id AND w.status = 'WAITING'), 0)::int as waitlist_count
    FROM events e
    JOIN users u ON e.organizer_id = u.id
    LEFT JOIN seats s ON s.event_id = e.id
    LEFT JOIN booking_seats bs ON bs.seat_id = s.id AND bs.status = 'CONFIRMED'
    LEFT JOIN bookings b ON b.id = bs.booking_id AND b.status = 'CONFIRMED'
    LEFT JOIN hold_seats hs ON hs.seat_id = s.id
    LEFT JOIN holds h ON h.id = hs.hold_id AND h.status = 'ACTIVE' AND h.expires_at > NOW()
    GROUP BY e.id, u.name, u.email
    ORDER BY e.start_time ASC;
  `;

  // 3. Query recent confirmed ticket sales
  const recentSalesSql = `
    SELECT 
      b.id as booking_id,
      b.created_at,
      b.checked_in,
      b.checked_in_at,
      e.id as event_id,
      e.title as event_title,
      e.venue,
      u.id as student_id,
      u.name as student_name,
      u.email as student_email,
      COUNT(bs.id)::int as ticket_count,
      ARRAY_AGG(s.row_label || s.seat_number::text ORDER BY s.row_label, s.seat_number) as seats_booked,
      ARRAY_AGG(COALESCE(bs.attendee_name, u.name)) as attendee_names
    FROM bookings b
    JOIN events e ON b.event_id = e.id
    JOIN users u ON b.student_id = u.id
    JOIN booking_seats bs ON bs.booking_id = b.id AND bs.status = 'CONFIRMED'
    JOIN seats s ON bs.seat_id = s.id
    WHERE b.status = 'CONFIRMED'
    GROUP BY b.id, e.id, u.id
    ORDER BY b.created_at DESC
    LIMIT 10;
  `;

  const [eventsResult, recentResult] = await Promise.all([
    db.query(eventsSql),
    db.query(recentSalesSql)
  ]);

  // Aggregate global totals
  let totalCapacity = 0;
  let totalTicketsBooked = 0;
  let totalHeldTickets = 0;
  let totalBlockedTickets = 0;
  let totalConfirmedBookings = 0;
  let totalCheckedIn = 0;
  let totalWaitlist = 0;

  const eventSales = eventsResult.rows.map(row => {
    const total = row.total_seats;
    const booked = row.booked_seats;
    const held = row.held_seats;
    const blocked = row.blocked_seats;
    const remaining = Math.max(0, total - booked - held - blocked);
    const occupancyRate = total > 0 ? Math.round((booked / total) * 100) : 0;
    const checkInRate = booked > 0 ? Math.round((row.checked_in_count / booked) * 100) : 0;

    totalCapacity += total;
    totalTicketsBooked += booked;
    totalHeldTickets += held;
    totalBlockedTickets += blocked;
    totalConfirmedBookings += row.confirmed_bookings_count;
    totalCheckedIn += row.checked_in_count;
    totalWaitlist += row.waitlist_count;

    return {
      ...row,
      remaining_seats: remaining,
      occupancy_rate: occupancyRate,
      check_in_rate: checkInRate
    };
  });

  const totalTicketsRemaining = Math.max(0, totalCapacity - totalTicketsBooked - totalHeldTickets - totalBlockedTickets);
  const overallOccupancyRate = totalCapacity > 0 ? Math.round((totalTicketsBooked / totalCapacity) * 100) : 0;
  const overallCheckInRate = totalTicketsBooked > 0 ? Math.round((totalCheckedIn / totalTicketsBooked) * 100) : 0;

  return {
    summary: {
      totalCapacity,
      totalTicketsBooked,
      totalTicketsRemaining,
      totalHeldTickets,
      totalBlockedTickets,
      totalConfirmedBookings,
      totalCheckedIn,
      totalWaitlist,
      overallOccupancyRate,
      overallCheckInRate,
      totalEvents: eventSales.length,
    },
    eventSales,
    recentSales: recentResult.rows,
  };
}

async function getOrganizerSalesDashboard(currentUser) {
  if (!currentUser || currentUser.role !== 'ORGANIZER') {
    const error = new Error('Access denied: Organizer Sales Dashboard requires ORGANIZER role');
    error.statusCode = 403;
    throw error;
  }

  const eventsResult = await db.query(`
    SELECT e.id, e.title, e.venue, e.start_time, e.is_published, e.theme_photo,
      (SELECT COUNT(*)::int FROM seats s WHERE s.event_id = e.id) AS total_seats,
      (SELECT COUNT(DISTINCT bs.id)::int FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
        WHERE b.event_id = e.id AND b.status = 'CONFIRMED' AND bs.status = 'CONFIRMED') AS booked_seats,
      (SELECT COUNT(DISTINCT hs.id)::int FROM hold_seats hs JOIN holds h ON h.id = hs.hold_id
        WHERE h.event_id = e.id AND h.status = 'ACTIVE' AND h.expires_at > NOW()) AS held_seats,
      (SELECT COUNT(*)::int FROM seats s WHERE s.event_id = e.id AND s.status = 'BLOCKED') AS blocked_seats,
      (SELECT COUNT(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status = 'CONFIRMED') AS confirmed_bookings_count,
      (SELECT COUNT(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status = 'CONFIRMED' AND b.checked_in = true) AS checked_in_count,
      (SELECT COUNT(*)::int FROM waitlist w WHERE w.event_id = e.id AND w.status = 'WAITING') AS waitlist_count
    FROM events e
    WHERE e.organizer_id = $1
    ORDER BY e.start_time ASC;
  `, [currentUser.id]);

  const recentResult = await db.query(`
    SELECT b.id AS booking_id, b.created_at, b.checked_in, b.checked_in_at,
      e.id AS event_id, e.title AS event_title, e.venue,
      u.name AS student_name, u.email AS student_email,
      COUNT(bs.id)::int AS ticket_count,
      ARRAY_AGG(s.row_label || s.seat_number::text ORDER BY s.row_label, s.seat_number) AS seats_booked
    FROM bookings b
    JOIN events e ON e.id = b.event_id
    JOIN users u ON u.id = b.student_id
    JOIN booking_seats bs ON bs.booking_id = b.id AND bs.status = 'CONFIRMED'
    JOIN seats s ON s.id = bs.seat_id
    WHERE e.organizer_id = $1 AND b.status = 'CONFIRMED'
    GROUP BY b.id, e.id, u.id
    ORDER BY b.created_at DESC
    LIMIT 10;
  `, [currentUser.id]);

  const eventSales = eventsResult.rows.map(event => ({
    ...event,
    remaining_seats: Math.max(0, event.total_seats - event.booked_seats - event.held_seats - event.blocked_seats),
    occupancy_rate: event.total_seats > 0 ? Math.round((event.booked_seats / event.total_seats) * 100) : 0,
  }));
  const summary = eventSales.reduce((totals, event) => {
    totals.totalCapacity += event.total_seats;
    totals.totalTicketsBooked += event.booked_seats;
    totals.totalTicketsRemaining += event.remaining_seats;
    totals.totalHeldTickets += event.held_seats;
    totals.totalBlockedTickets += event.blocked_seats;
    totals.totalConfirmedBookings += event.confirmed_bookings_count;
    totals.totalCheckedIn += event.checked_in_count;
    totals.totalWaitlist += event.waitlist_count;
    return totals;
  }, {
    totalCapacity: 0, totalTicketsBooked: 0, totalTicketsRemaining: 0,
    totalHeldTickets: 0, totalBlockedTickets: 0, totalConfirmedBookings: 0,
    totalCheckedIn: 0, totalWaitlist: 0,
  });
  summary.overallOccupancyRate = summary.totalCapacity > 0 ? Math.round((summary.totalTicketsBooked / summary.totalCapacity) * 100) : 0;
  summary.overallCheckInRate = summary.totalTicketsBooked > 0 ? Math.round((summary.totalCheckedIn / summary.totalTicketsBooked) * 100) : 0;
  summary.totalEvents = eventSales.length;

  return { summary, eventSales, recentSales: recentResult.rows };
}

/**
 * Return sales, inventory, and recent bookings for one event.
 * @param {object} currentUser - Must have ADMIN role
 * @param {number|string} eventId - Event to display
 */
async function getAdminEventDashboard(currentUser, eventId) {
  if (!currentUser || currentUser.role !== 'ADMIN') {
    const error = new Error('Access denied: Sales Dashboard requires ADMIN role');
    error.statusCode = 403;
    throw error;
  }

  return getEventDashboardData(eventId, null);
}

async function getOrganizerEventDashboard(currentUser, eventId) {
  if (!currentUser || currentUser.role !== 'ORGANIZER') {
    const error = new Error('Access denied: Organizer Sales Dashboard requires ORGANIZER role');
    error.statusCode = 403;
    throw error;
  }
  return getEventDashboardData(eventId, currentUser.id);
}

async function getEventDashboardData(eventId, organizerId) {
  const eventResult = await db.query(`
    SELECT e.id, e.title, e.description, e.venue, e.start_time, e.end_time,
      e.is_published, e.theme_photo, u.name AS organizer_name, u.email AS organizer_email,
      (SELECT COUNT(*)::int FROM seats s WHERE s.event_id = e.id) AS total_seats,
      (SELECT COUNT(DISTINCT bs.id)::int
        FROM booking_seats bs
        JOIN bookings b ON b.id = bs.booking_id
        WHERE b.event_id = e.id AND b.status = 'CONFIRMED' AND bs.status = 'CONFIRMED') AS booked_seats,
      (SELECT COUNT(DISTINCT hs.id)::int
        FROM hold_seats hs
        JOIN holds h ON h.id = hs.hold_id
        WHERE h.event_id = e.id AND h.status = 'ACTIVE' AND h.expires_at > NOW()) AS held_seats,
      (SELECT COUNT(*)::int FROM seats s WHERE s.event_id = e.id AND s.status = 'BLOCKED') AS blocked_seats,
      (SELECT COUNT(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status = 'CONFIRMED') AS confirmed_bookings_count,
      (SELECT COUNT(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status = 'CONFIRMED' AND b.checked_in = true) AS checked_in_count,
      (SELECT COUNT(*)::int FROM waitlist w WHERE w.event_id = e.id AND w.status = 'WAITING') AS waitlist_count
    FROM events e
    JOIN users u ON u.id = e.organizer_id
    WHERE e.id = $1 AND ($2::int IS NULL OR e.organizer_id = $2);
  `, [eventId, organizerId]);

  if (!eventResult.rows.length) {
    const error = new Error('The requested event could not be found.');
    error.statusCode = 404;
    throw error;
  }

  const event = eventResult.rows[0];
  event.remaining_seats = Math.max(0, event.total_seats - event.booked_seats - event.held_seats - event.blocked_seats);
  event.occupancy_rate = event.total_seats > 0 ? Math.round((event.booked_seats / event.total_seats) * 100) : 0;
  event.check_in_rate = event.booked_seats > 0 ? Math.round((event.checked_in_count / event.booked_seats) * 100) : 0;

  const recentResult = await db.query(`
    SELECT b.id AS booking_id, b.created_at, b.checked_in, b.checked_in_at,
      u.name AS student_name, u.email AS student_email,
      COUNT(bs.id)::int AS ticket_count,
      ARRAY_AGG(s.row_label || s.seat_number::text ORDER BY s.row_label, s.seat_number) AS seats_booked,
      ARRAY_AGG(COALESCE(bs.attendee_name, u.name) ORDER BY s.row_label, s.seat_number) AS attendee_names
    FROM bookings b
    JOIN users u ON u.id = b.student_id
    JOIN booking_seats bs ON bs.booking_id = b.id AND bs.status = 'CONFIRMED'
    JOIN seats s ON s.id = bs.seat_id
    WHERE b.event_id = $1 AND b.status = 'CONFIRMED'
    GROUP BY b.id, u.id
    ORDER BY b.created_at DESC
    LIMIT 50;
  `, [eventId]);

  return { event, recentSales: recentResult.rows };
}

module.exports = {
  getAdminSalesDashboard,
  getOrganizerSalesDashboard,
  getAdminEventDashboard,
  getOrganizerEventDashboard,
};
