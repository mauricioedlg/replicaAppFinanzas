export class EmailDeliveryError extends Error {}

export function createEmail(config, request = fetch) {
  function ensureConfigured() {
    if (!config.resendApiKey || !config.resendFromEmail) {
      throw new EmailDeliveryError('Resend no está configurado.');
    }
    const addresses = [config.resendFromEmail, config.resendReplyToEmail].filter(Boolean);
    for (const value of addresses) {
      const address = value.match(/<([^<>]+)>$/)?.[1] ?? value;
      if (/[\r\n]/.test(value) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address)) {
        throw new EmailDeliveryError('Remitente de Resend inválido.');
      }
    }
    if (!(config.resendTimeoutSeconds > 0 && config.resendTimeoutSeconds <= 60)) {
      throw new EmailDeliveryError('Tiempo de espera de Resend inválido.');
    }
    return config.resendTimeoutSeconds * 1000;
  }

  async function send({ to, subject, text, html, idempotencyKey }) {
    const timeout = ensureConfigured();
    const payload = { from: config.resendFromEmail, to: [to], subject, text, html };
    if (config.resendReplyToEmail) payload.reply_to = config.resendReplyToEmail;
    try {
      const response = await request('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'AppFinanzasMauricio/1.0',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.ceil(timeout)),
      });
      if (!response.ok) {
        await response.body?.cancel();
        console.warn('Resend rechazó el correo.', response.status);
        throw new EmailDeliveryError('No se pudo enviar el correo.');
      }
      const result = await response.json();
      if (!result?.id) throw new EmailDeliveryError('Respuesta inválida del proveedor de correo.');
      return result.id;
    } catch (error) {
      if (error instanceof EmailDeliveryError) throw error;
      console.warn('No se pudo contactar a Resend.', error.name);
      throw new EmailDeliveryError('No se pudo enviar el correo.');
    }
  }
  return { ensureConfigured, send };
}
