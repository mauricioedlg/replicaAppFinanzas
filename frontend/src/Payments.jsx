import { useCallback, useEffect, useRef, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js/pure';
import { AlertCircle, Check, CirclePlus, CreditCard, LoaderCircle, Mail, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { api } from './api';

const MONEY = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const money = (value) => MONEY.format(Number(value || 0));
const stripeClients = new Map();
const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function stripeFor(key) {
  if (!stripeClients.has(key)) stripeClients.set(key, loadStripe(key).then((stripe) => {
    if (!stripe) stripeClients.delete(key);
    return stripe;
  }).catch((error) => { stripeClients.delete(key); throw error; }));
  return stripeClients.get(key);
}

function Notice({ children, error = false }) {
  if (!children) return null;
  return <div className={error ? 'error-notice payment-notice' : 'payment-notice payment-information'} role={error ? 'alert' : 'status'}>{error ? <AlertCircle size={18} /> : <ShieldCheck size={18} />}<span>{children}</span></div>;
}

function Loading({ children = 'Cargando tarjetas…' }) {
  return <div className="payment-loading" role="status"><LoaderCircle className="spin" size={19} />{children}</div>;
}

function usePaymentResources() {
  const [configuration, setConfiguration] = useState(null);
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const controller = useRef(null);
  const reload = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoading(true); setError('');
    try {
      const [config, result] = await Promise.all([
        api('/payments/config/', { signal: current.signal }),
        api('/cards/', { signal: current.signal }),
      ]);
      if (current.signal.aborted) return;
      setConfiguration(config); setCards(result.cards || []);
    } catch (failure) {
      if (!current.signal.aborted && !failure.sessionExpired) setError(failure.message);
    } finally { if (!current.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => { reload(); return () => controller.current?.abort(); }, [reload]);
  return { configuration, cards, loading, error, reload };
}

function cardLabel(card) {
  return card.last4 ? `${card.brand || 'Tarjeta'} •••• ${card.last4}` : 'Registro de tarjeta pendiente';
}

function useSeconds(deadline) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!deadline) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return Math.max(0, Math.ceil(((deadline || 0) - now) / 1000));
}

function SetupForm({ card, onRegistered, onBusy }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    if (!stripe || !elements || busy || !consent) return;
    setBusy(true); onBusy(true); setError('');
    try {
      const result = await stripe.confirmSetup({
        elements,
        confirmParams: { return_url: `${location.origin}/?stripe_return=card&card_id=${encodeURIComponent(card.id)}#configuracion` },
        redirect: 'if_required',
      });
      if (result.error) setError(result.error.message || 'No se pudo registrar la tarjeta de prueba.');
      else if (result.setupIntent?.status === 'succeeded') await onRegistered(card.id);
      else setError('El registro de la tarjeta todavía no se completa. Inténtalo de nuevo.');
    } catch (failure) { setError(failure.message || 'No pudimos conectar con Stripe. Inténtalo de nuevo.'); }
    finally { setBusy(false); onBusy(false); }
  }
  return <form onSubmit={submit} className="payment-form">
    <p className="payment-description">Usa una tarjeta de prueba. Después te enviaremos un código para autorizar su registro.</p>
    <PaymentElement onReady={() => setReady(true)} onLoadError={() => setError('No se pudo cargar el formulario de Stripe. Revisa tu conexión e inténtalo de nuevo.')} />
    {!ready && !error && <Loading>Cargando el formulario seguro…</Loading>}
    <label className="payment-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required /><span>Guardar esta tarjeta de prueba para las recargas que yo confirme.</span></label>
    <Notice error>{error}</Notice>
    <button className="button button-primary full-width" disabled={!stripe || !ready || !consent || busy}>{busy ? <LoaderCircle size={18} className="spin" /> : <CreditCard size={18} />} Continuar con la verificación</button>
    <p className="payment-footnote">Stripe procesa los datos de prueba. Esta aplicación muestra únicamente la marca y los últimos cuatro dígitos.</p>
  </form>;
}

export function CardManager({ user, Modal }) {
  const { configuration, cards, loading, error: loadError, reload } = usePaymentResources();
  const [setup, setSetup] = useState(null);
  const [challenge, setChallenge] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [retryAt, setRetryAt] = useState(0);
  const [expiresAt, setExpiresAt] = useState(0);
  const setupRequest = useRef(null);
  const handledReturn = useRef(false);
  const mounted = useRef(true);
  const retrySeconds = useSeconds(retryAt);
  const expiresSeconds = useSeconds(expiresAt);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const previousEmail = useRef(user.email);
  useEffect(() => {
    if (previousEmail.current !== user.email) { previousEmail.current = user.email; reload(); }
  }, [user.email, reload]);

  async function requestCode(cardId) {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api(`/cards/${cardId}/verification/request/`, { method: 'POST', body: {} });
      if (!mounted.current) return;
      setSetup(null); setCode('');
      setChallenge({ ...result, card: result.card || cards.find((item) => item.id === cardId) || { id: cardId } });
      setRetryAt(Date.now() + (result.retry_after || 60) * 1000);
      setExpiresAt(Date.now() + (result.expires_in || 600) * 1000);
    } catch (failure) {
      if (mounted.current && !failure.sessionExpired) {
        setSetup(null); setError(failure.message);
        if (failure.fields?.retry_after) setRetryAt(Date.now() + Number(failure.fields.retry_after) * 1000);
      }
    } finally { if (mounted.current) { setBusy(false); reload(); } }
  }

  useEffect(() => {
    const url = new URL(location.href);
    if (handledReturn.current || url.searchParams.get('stripe_return') !== 'card') return;
    handledReturn.current = true;
    const cardId = url.searchParams.get('card_id');
    for (const name of ['stripe_return', 'card_id', 'setup_intent', 'setup_intent_client_secret', 'redirect_status']) url.searchParams.delete(name);
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
    if (cardId && uuidPattern.test(cardId)) requestCode(cardId);
    // A return URL is handled once; all ownership and completion checks are server-side.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function beginSetup() {
    if (busy || !configuration?.configured) return;
    setBusy(true); setError(''); setMessage('');
    setupRequest.current ||= crypto.randomUUID();
    try {
      const result = await api('/cards/setup/', { method: 'POST', body: { request_id: setupRequest.current } });
      if (mounted.current) setSetup(result);
    } catch (failure) { if (mounted.current && !failure.sessionExpired) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function confirmCode(event) {
    event.preventDefault();
    if (busy || !/^\d{6}$/.test(code)) return;
    setBusy(true); setError('');
    try {
      await api(`/cards/${challenge.card.id}/verification/confirm/`, { method: 'POST', body: { challenge_id: challenge.challenge_id, code } });
      if (!mounted.current) return;
      setChallenge(null); setCode(''); setMessage('Tarjeta verificada. Ya puedes utilizarla para agregar fondos de prueba.');
      await reload();
    } catch (failure) { if (mounted.current && !failure.sessionExpired) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function removeCard() {
    if (busy || !removing) return;
    setBusy(true); setError('');
    try {
      await api(`/cards/${removing.id}/`, { method: 'DELETE' });
      if (!mounted.current) return;
      setRemoving(null); setMessage('La tarjeta se quitó de tus métodos de recarga.'); await reload();
    } catch (failure) { if (mounted.current && !failure.sessionExpired) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }

  function close() {
    if (busy) return;
    setSetup(null); setChallenge(null); setRemoving(null); setCode(''); setError(''); setupRequest.current = null;
    reload();
  }

  const modalOpen = Boolean(setup || challenge || removing);
  return <section className="card payments-card" aria-labelledby="payment-cards-title">
    <div className="card-header"><div><h2 id="payment-cards-title">Mis tarjetas</h2><p>Tarjetas de prueba para recargar tu saldo simulado.</p></div><CreditCard size={24} /></div>
    {loading ? <Loading /> : <>
      <Notice error>{loadError}</Notice>
      {!configuration?.configured && !loadError && <Notice>{configuration?.detail || 'Los pagos de prueba todavía no están habilitados.'}</Notice>}
      {cards.length ? <ul className="payment-card-list">{cards.map((card) => <li key={card.id} className="saved-card"><span className="saved-card-icon"><CreditCard size={22} /></span><div><strong>{cardLabel(card)}</strong><span>{card.exp_month && card.exp_year ? `Vence ${String(card.exp_month).padStart(2, '0')}/${card.exp_year}` : 'Completa el registro para usarla'}</span></div><div className="saved-card-status"><span className={`payment-status ${card.status === 'active' ? 'payment-status-active' : ''}`}>{card.status === 'active' ? 'Verificada' : card.status === 'expired' ? 'Vencida' : 'Pendiente'}</span>{card.status === 'pending' && <button type="button" className="text-button" onClick={() => requestCode(card.id)} disabled={busy || modalOpen || !configuration?.configured}>Verificar</button>}<button type="button" className="text-button" onClick={() => { setRemoving(card); setError(''); }} disabled={busy || modalOpen} aria-label={`Quitar ${cardLabel(card)}`}>Quitar</button></div></li>)}</ul> : !loadError && <p className="payment-empty">Todavía no tienes tarjetas. Agrega una de prueba y confirma el código que recibirás por correo.</p>}
    </>}
    {!modalOpen && <><Notice error>{error}</Notice><Notice>{message}</Notice></>}
    <div className="payment-card-actions"><button type="button" className="button button-primary" onClick={beginSetup} disabled={loading || busy || modalOpen || !configuration?.configured}>{busy && !modalOpen ? <LoaderCircle size={17} className="spin" /> : <CirclePlus size={17} />} Agregar tarjeta de prueba</button>{loadError && <button type="button" className="text-button" onClick={reload}>Volver a cargar</button>}</div>
    <p className="payment-footnote">La verificación de cada tarjeta se envía al correo de tu cuenta. No se realizan cargos reales.</p>
    {setup && <Modal title="Agrega tu tarjeta de prueba" subtitle="Registro seguro con Stripe" onClose={close} busy={busy}><Elements stripe={stripeFor(configuration.publishable_key)} options={{ clientSecret: setup.client_secret, appearance: { theme: user.dark_mode ? 'night' : 'stripe', variables: { colorPrimary: '#28583f', fontFamily: 'system-ui, sans-serif', borderRadius: '7px' } }, locale: 'es' }} key={setup.card.id}><SetupForm card={setup.card} onRegistered={async (id) => { setupRequest.current = null; await requestCode(id); }} onBusy={setBusy} /></Elements></Modal>}
    {challenge && <Modal title="Confirma tu tarjeta" subtitle="Un código para autorizar el registro" onClose={close} busy={busy}><form onSubmit={confirmCode} className="payment-form"><div className="payment-code-icon"><Mail size={25} /></div><p className="payment-description">Enviamos un código a <strong>{challenge.email_hint || user.email}</strong>. Escríbelo para activar {cardLabel(challenge.card)}.</p><label className="payment-code-label">Código de verificación<input autoFocus className="payment-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} required /></label><p className="payment-footnote">{expiresSeconds ? `El código vence en ${Math.floor(expiresSeconds / 60)}:${String(expiresSeconds % 60).padStart(2, '0')}.` : 'El código venció. Solicita uno nuevo.'}</p><Notice error>{error}</Notice><button className="button button-primary full-width" disabled={busy || code.length !== 6 || !expiresSeconds}>{busy ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />} Verificar tarjeta</button><button type="button" className="text-button payment-resend" disabled={busy || retrySeconds > 0} onClick={() => requestCode(challenge.card.id)}>{retrySeconds ? `Reenviar código en ${retrySeconds} s` : 'Reenviar código'}</button></form></Modal>}
    {removing && <Modal title="Quitar tarjeta" subtitle="Dejar de usarla para nuevas recargas" onClose={close} busy={busy}><p className="payment-description">Se quitará {cardLabel(removing)} de tus métodos de recarga. El historial de tus operaciones seguirá disponible.</p><Notice error>{error}</Notice><button type="button" className="button button-primary full-width" onClick={removeCard} disabled={busy}>{busy && <LoaderCircle className="spin" size={17} />} Quitar tarjeta</button><button type="button" className="text-button payment-resend" onClick={close} disabled={busy}>Conservar tarjeta</button></Modal>}
  </section>;
}

function attemptStorageKey(userId) { return `folio:stripe:topup:${userId}`; }
function readAttempt(userId) {
  try {
    const value = JSON.parse(sessionStorage.getItem(attemptStorageKey(userId)) || 'null');
    return value && uuidPattern.test(value.request_id) && (!value.topup_id || uuidPattern.test(value.topup_id)) ? value : null;
  } catch { return null; }
}
function storeAttempt(userId, value) {
  try {
    if (value) sessionStorage.setItem(attemptStorageKey(userId), JSON.stringify(value));
    else sessionStorage.removeItem(attemptStorageKey(userId));
  } catch { /* The in-memory request still prevents duplicate submissions. */ }
}

export function StripeFundsModal({ userId, balance, Modal, onClose, onComplete, onManageCards }) {
  const { configuration, cards, loading, error: loadError, reload } = usePaymentResources();
  const attempt = useRef(readAttempt(userId));
  const [amount, setAmount] = useState(attempt.current?.amount || '1000');
  const [cardId, setCardId] = useState(attempt.current?.card_id || '');
  const [topup, setTopup] = useState(attempt.current?.topup_id ? { id: attempt.current.topup_id, status: 'pending', amount: attempt.current.amount } : null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkCycle, setCheckCycle] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const mounted = useRef(true);
  const completed = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const requestController = useRef(null);
  onCompleteRef.current = onComplete;
  const activeCards = cards.filter((card) => card.status === 'active');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestController.current?.abort(); }; }, []);
  useEffect(() => {
    if (!loading && !topup && !activeCards.some((card) => card.id === cardId)) setCardId(activeCards[0]?.id || '');
  }, [loading, cards, cardId, topup]);

  const finish = useCallback(async () => {
    if (completed.current || !mounted.current) return;
    completed.current = true; storeAttempt(userId, null); setChecking(false);
    await onCompleteRef.current('Recarga de prueba acreditada. Recibirás la confirmación por correo.');
  }, [userId]);

  useEffect(() => {
    if (!topup?.id || topup.status !== 'pending') return undefined;
    const controller = new AbortController();
    let timer;
    const deadline = Date.now() + 30000;
    setChecking(true);
    async function poll() {
      try {
        const result = await api(`/funds/${topup.id}/`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (result.topup.status === 'succeeded') { await finish(); return; }
        if (result.topup.status === 'failed') {
          setTopup(result.topup); setChecking(false); storeAttempt(userId, null);
          setMessage('El pago no se completó. No se agregó saldo. Puedes iniciar otra recarga.'); return;
        }
        if (Date.now() >= deadline) {
          setChecking(false); setMessage('La recarga sigue pendiente. Puedes cerrar esta ventana y comprobarla después. El saldo se agregará cuando se confirme el pago.'); return;
        }
        timer = setTimeout(poll, 2000);
      } catch (failure) {
        if (controller.signal.aborted || failure.sessionExpired) return;
        setChecking(false); setError(failure.message);
        if (failure.status === 404) { setTopup(null); attempt.current = null; storeAttempt(userId, null); }
      }
    }
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [topup?.id, topup?.status, checkCycle, finish, userId]);

  function changeAmount(value) { setAmount(value); attempt.current = null; storeAttempt(userId, null); setError(''); }
  function changeCard(value) { setCardId(value); attempt.current = null; storeAttempt(userId, null); setError(''); }
  async function submit(event, resume = false) {
    event.preventDefault();
    if (busy || (topup?.status === 'pending' && !resume) || !configuration?.configured || !cardId) return;
    setBusy(true); setError(''); setMessage('');
    if (!attempt.current || attempt.current.amount !== amount || attempt.current.card_id !== cardId) attempt.current = { request_id: crypto.randomUUID(), amount, card_id: cardId };
    storeAttempt(userId, attempt.current);
    const controller = new AbortController(); requestController.current = controller;
    try {
      const result = await api('/funds/', { method: 'POST', body: { amount, card_id: cardId, request_id: attempt.current.request_id }, signal: controller.signal });
      if (!mounted.current) return;
      attempt.current = { ...attempt.current, topup_id: result.topup.id, needs_confirmation: true }; storeAttempt(userId, attempt.current);
      if (result.topup.status === 'succeeded') { await finish(); return; }
      if (result.topup.status === 'failed') {
        setTopup(result.topup); storeAttempt(userId, null); setMessage('El pago no se completó. Puedes iniciar otra recarga.'); return;
      }
      // Keep the request identity before calling Stripe so a lost response or
      // closed browser cannot turn a retry into a second logical payment.
      const stripe = await stripeFor(configuration.publishable_key);
      if (!mounted.current) return;
      if (!stripe) throw new Error('No se pudo cargar Stripe. Revisa tu conexión y vuelve a intentarlo.');
      const confirmation = await stripe.confirmCardPayment(result.client_secret);
      if (!mounted.current) return;
      if (confirmation.error) setError(confirmation.error.message || 'No se pudo confirmar el pago. Comprueba el estado de la recarga.');
      else {
        attempt.current = { ...attempt.current, needs_confirmation: false }; storeAttempt(userId, attempt.current);
        setMessage('Pago enviado. Estamos esperando la confirmación para acreditar tu saldo.');
      }
      setTopup(result.topup); setCheckCycle((value) => value + 1);
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && !failure.sessionExpired) {
        setError(failure.message || 'No se pudo completar el pago. Inténtalo de nuevo.');
        // Preserve the request UUID and recover an existing payment if Stripe
        // loaded unsuccessfully after the server returned a pending top-up.
        if (attempt.current?.topup_id) setTopup({ id: attempt.current.topup_id, status: 'pending', amount });
      }
    } finally { if (mounted.current) setBusy(false); }
  }

  function anotherTopup() {
    attempt.current = null; storeAttempt(userId, null); setTopup(null); setMessage(''); setError('');
  }
  const validAmount = /^\d+(?:\.\d{1,2})?$/.test(amount) && Number(amount) >= Number(configuration?.min_amount || 10) && Number(amount) <= Number(configuration?.max_amount || 999999.99);
  return <Modal title="Agrega fondos de prueba" subtitle="Recarga con una tarjeta verificada" onClose={onClose} busy={busy}>
    <div className="funds-balance"><Wallet size={23} /><span>Tu saldo actual<strong>{money(balance)}</strong></span></div>
    {topup?.status === 'pending' ? <div className="payment-pending"><span className="payment-code-icon"><RefreshCw size={25} className={checking ? 'spin' : ''} /></span><h3>Recarga pendiente de confirmación</h3><strong>{money(topup.amount || amount)}</strong><p>El saldo se acreditará cuando el servidor confirme el pago. Esta recarga queda guardada para que puedas volver a consultarla.</p><Notice error>{error}</Notice><Notice>{message}</Notice>{attempt.current?.needs_confirmation && configuration?.configured && <button type="button" className="button button-outline full-width payment-resume" onClick={(event) => submit(event, true)} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <CreditCard size={17} />} Continuar el pago pendiente</button>}<button type="button" className="button button-primary full-width" disabled={checking || busy} onClick={() => { setError(''); setMessage(''); setCheckCycle((value) => value + 1); }}>{checking ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />} {checking ? 'Comprobando recarga…' : 'Comprobar recarga'}</button></div> : topup?.status === 'failed' ? <div className="payment-pending"><Notice>{message || 'El pago no se completó y no se agregó saldo.'}</Notice><button type="button" className="button button-primary full-width" onClick={anotherTopup}>Iniciar otra recarga</button></div> : loading ? <Loading /> : <>
      <Notice error>{loadError}</Notice>
      {!configuration?.configured && !loadError ? <Notice>{configuration?.detail || 'Los pagos de prueba todavía no están habilitados.'}</Notice> : !activeCards.length && !loadError ? <div className="payment-empty"><p>Agrega una tarjeta de prueba y verifícala por correo para comenzar.</p><button type="button" className="button button-primary" onClick={onManageCards}><CreditCard size={17} /> Ir a Mis tarjetas</button></div> : configuration?.configured && <form className="payment-form" onSubmit={submit}>
        <label className="payment-card-select">Tarjeta para la recarga<select value={cardId} onChange={(event) => changeCard(event.target.value)} required disabled={busy}>{activeCards.map((card) => <option value={card.id} key={card.id}>{cardLabel(card)}</option>)}</select></label>
        <label className="trade-quantity">Monto a agregar (MXN)<input type="number" inputMode="decimal" min={configuration.min_amount} max={configuration.max_amount} step="0.01" value={amount} onChange={(event) => changeAmount(event.target.value)} required disabled={busy} /><small>Desde {money(configuration.min_amount)} MXN.</small></label>
        <div className="funds-presets">{[500, 1000, 5000, 10000].filter((value) => value >= Number(configuration.min_amount) && value <= Number(configuration.max_amount)).map((value) => <button key={value} type="button" disabled={busy} className={Number(amount) === value ? 'selected' : ''} onClick={() => changeAmount(String(value))}>{money(value)}</button>)}</div>
        <Notice error>{error}</Notice><Notice>{message}</Notice>
        <p className="trade-disclaimer"><ShieldCheck size={17} /> Pago en el entorno de pruebas de Stripe. No se mueve dinero real. Te enviaremos un correo cuando el saldo simulado se acredite.</p>
        <button className="button button-primary full-width" disabled={busy || !validAmount || !cardId}>{busy ? <LoaderCircle className="spin" size={18} /> : <CirclePlus size={18} />} {busy ? 'Procesando pago…' : 'Confirmar recarga de prueba'}</button>
        <button type="button" className="text-button payment-resend" onClick={onManageCards} disabled={busy}>Administrar mis tarjetas</button>
      </form>}
      {loadError && <button type="button" className="text-button" onClick={reload}>Volver a cargar</button>}
    </>}
  </Modal>;
}
