import { Request, Response } from 'express';

export interface TelemetryEvent {
  id: string;
  event: 'metrics' | 'gas' | 'log' | 'heartbeat';
  data: any;
}

export class SseTelemetryEngine {
  private static clients: Set<Response> = new Set();
  private static eventHistory: TelemetryEvent[] = [];
  private static maxHistorySize: number = 100;

  /**
   * Handle incoming SSE connection subscription
   */
  public static handleSubscription(req: Request, res: Response): void {
    // 1. Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx proxy buffering

    res.flushHeaders?.();

    const lastEventIdHeader =
      req.headers['last-event-id'] || req.query.lastEventId;

    // 2. If client provided Last-Event-ID, replay missed events from history buffer
    if (lastEventIdHeader) {
      const lastIdNum = parseInt(lastEventIdHeader as string, 10);
      const missedEvents = SseTelemetryEngine.eventHistory.filter(
        (e) => parseInt(e.id, 10) > lastIdNum
      );
      for (const event of missedEvents) {
        res.write(`id: ${event.id}\n`);
        res.write(`event: ${event.event}\n`);
        res.write(`data: ${JSON.stringify(event.data)}\n\n`);
      }
    }

    // Register active client
    SseTelemetryEngine.clients.add(res);

    // 3. Setup 15-second keep-alive heartbeat interval
    const heartbeatTimer = setInterval(() => {
      res.write(`event: heartbeat\n`);
      res.write(`data: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
    }, 15000);

    // 4. Clean up connection on client disconnect
    req.on('close', () => {
      clearInterval(heartbeatTimer);
      SseTelemetryEngine.clients.delete(res);
      res.end();
    });
  }

  /**
   * Broadcast telemetry event to all active SSE subscribers
   */
  public static broadcast(event: Omit<TelemetryEvent, 'id'>): void {
    const eventId = Date.now().toString();
    const fullEvent: TelemetryEvent = { id: eventId, ...event };

    // Store in event history ring buffer for reconnection recovery
    SseTelemetryEngine.eventHistory.push(fullEvent);
    if (
      SseTelemetryEngine.eventHistory.length > SseTelemetryEngine.maxHistorySize
    ) {
      SseTelemetryEngine.eventHistory.shift();
    }

    const payload = `id: ${fullEvent.id}\nevent: ${fullEvent.event}\ndata: ${JSON.stringify(
      fullEvent.data
    )}\n\n`;

    for (const client of SseTelemetryEngine.clients) {
      try {
        client.write(payload);
      } catch (err) {
        SseTelemetryEngine.clients.delete(client);
      }
    }
  }

  public static getActiveClientCount(): number {
    return SseTelemetryEngine.clients.size;
  }
}
