import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowDownToLine, ArrowRight, ArrowUpFromLine, ArrowUpRight, BriefcaseBusiness, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, CirclePlus, Eye, EyeOff, House, Leaf, LoaderCircle, LogOut, Menu, Moon, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Sun, TrendingUp, Wallet, X, ArrowLeftRight, AlertCircle } from 'lucide-react';
import { api, initializeSession, SESSION_EXPIRED_EVENT } from './api';
import { CardManager, decimalUnits, StripeFundsModal, WithdrawalModal } from './Payments';
import { stockLogoFiles } from './stockLogos';

const MONEY = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 2 });
const NUMBER = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 6 });
const COMPACT_NUMBER = new Intl.NumberFormat('es-MX', { notation: 'compact', maximumFractionDigits: 1 });
const money = (value) => MONEY.format(value || 0);
const number = (value) => NUMBER.format(Number(value || 0));
const percent = (value, digits = 2) => `${Number(value || 0) > 0 ? '+' : ''}${Number(value || 0).toFixed(digits)}%`;
const dateValue = (value) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00` : value);
const localDate = (value, options = {}) => dateValue(value).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', ...options });
const localDateTime = (value) => dateValue(value).toLocaleString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const NAV = [
  { id: 'inicio', title: 'Inicio', icon: House },
  { id: 'portafolio', title: 'Mi portafolio', icon: BriefcaseBusiness },
  { id: 'invertir', title: 'Invertir', icon: TrendingUp },
  { id: 'transacciones', title: 'Transacciones', icon: ArrowLeftRight },
  { id: 'configuracion', title: 'Configuración', icon: Settings2 },
];
const pageFromHash = () => NAV.some((item) => item.id === location.hash.slice(1)) ? location.hash.slice(1) : 'inicio';
const initials = (name) => (name || 'Usuario').split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

function Logo({ dark = false }) {
  return <div className={`brand ${dark ? 'brand-dark' : ''}`} aria-label="App Finanzas Mauricio"><Wallet className="brand-icon" size={25} aria-hidden="true" /><span className="brand-name">APP FINANZAS<strong>MAURICIO</strong></span></div>;
}

function Loading({ label = 'Cargando tu espacio…' }) {
  return <div className="loading-state" role="status"><LoaderCircle className="spin" size={28} /><span>{label}</span></div>;
}

function ErrorNotice({ message, onRetry }) {
  if (!message) return null;
  return <div className="error-notice" role="alert"><AlertCircle size={18} /><span>{message}</span>{onRetry && <button className="text-button" onClick={onRetry}>Reintentar</button>}</div>;
}

function Empty({ icon: Icon = BriefcaseBusiness, title, text, action }) {
  return <div className="empty-state"><span><Icon size={27} /></span><h3>{title}</h3><p>{text}</p>{action}</div>;
}

function StockMark({ stock, small = false }) {
  const logoFile = stockLogoFiles.get(stock?.symbol);
  const [failedLogo, setFailedLogo] = useState(null);
  const showLogo = logoFile && logoFile !== failedLogo;
  const classes = ['stock-mark', small && 'stock-mark-small', showLogo && 'stock-mark-logo'].filter(Boolean).join(' ');

  return <span className={classes} style={{ '--stock-color': stock?.color || '#476e59' }} aria-hidden="true">
    {showLogo
      ? <img src={`${import.meta.env.BASE_URL}logos/${logoFile}`} alt="" decoding="async" loading="lazy" onError={() => setFailedLogo(logoFile)} />
      : (stock?.symbol || '?').slice(0, 2)}
  </span>;
}

function Change({ value, plain = false }) {
  const positive = Number(value) >= 0;
  return <span className={`change ${positive ? 'positive' : 'negative'} ${plain ? 'change-plain' : ''}`}>{positive ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}{percent(value)}</span>;
}

function PasswordInput({ id, ...props }) {
  const [visible, setVisible] = useState(false);
  return <div className="password-input"><input id={id} type={visible ? 'text' : 'password'} {...props} /><button type="button" aria-label={visible ? 'Ocultar contraseña' : 'Mostrar contraseña'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>;
}

function PasswordRecovery({ initialEmail = '', onBack, onComplete }) {
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState(initialEmail);
  const [challengeId, setChallengeId] = useState('');
  const [code, setCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const retryIn = Math.max(0, Math.ceil((resendAt - now) / 1000));

  useEffect(() => {
    if (step !== 'code' || !resendAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [step, resendAt]);

  async function post(path, body) {
    await api('/auth/csrf/', { checkSession: false });
    return api(`/auth/password-reset/${path}/`, { method: 'POST', body, checkSession: false });
  }

  async function sendCode(event) {
    event?.preventDefault();
    if (busy || (step === 'code' && retryIn > 0)) return;
    setBusy(true);
    setError('');
    try {
      const normalizedEmail = email.trim().toLowerCase();
      const result = await post('request', { email: normalizedEmail });
      setEmail(normalizedEmail);
      setChallengeId(result.challenge_id);
      setCode('');
      setResetToken('');
      setMessage(result.detail);
      const currentTime = Date.now();
      setNow(currentTime);
      setResendAt(currentTime + (Number(result.retry_after) || 60) * 1000);
      setStep('code');
    } catch (failure) {
      setError(failure.message);
      if (failure.status === 429 && Number(failure.fields.retry_after) > 0) {
        const currentTime = Date.now();
        setNow(currentTime);
        setResendAt(currentTime + Number(failure.fields.retry_after) * 1000);
      }
    } finally { setBusy(false); }
  }

  async function verifyCode(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await post('verify', { email, challenge_id: challengeId, code });
      setResetToken(result.reset_token);
      setCode('');
      setMessage('');
      setStep('password');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  async function savePassword(event) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (password !== confirmPassword) return setError('Las contraseñas no coinciden.');
    setBusy(true);
    try {
      const result = await post('confirm', { email, challenge_id: challengeId, reset_token: resetToken, password, confirm_password: confirmPassword });
      setPassword('');
      setConfirmPassword('');
      setResetToken('');
      setChallengeId('');
      onComplete({ ...result, email });
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  function startOver() {
    setStep('email');
    setChallengeId('');
    setCode('');
    setResetToken('');
    setPassword('');
    setConfirmPassword('');
    setError('');
    setMessage('');
  }

  const stepNumber = { email: 1, code: 2, password: 3 }[step];
  return <>
    <span className="eyebrow">RECUPERA TU CUENTA · PASO {stepNumber} DE 3</span>
    <h2>{step === 'email' ? 'Recupera tu contraseña.' : step === 'code' ? 'Revisa tu correo.' : 'Crea tu nueva contraseña.'}</h2>
    <p className="muted">{step === 'email' ? 'Escribe el correo electrónico con el que creaste tu cuenta para recibir un código de verificación.' : step === 'code' ? <>Ingresa el código de 6 dígitos enviado a <strong className="recovery-email">{email}</strong>. Revisa también tu carpeta de spam.</> : 'Elige una contraseña segura que no uses en otros sitios.'}</p>
    {message && <div className="auth-status auth-status-info" role="status"><ShieldCheck size={18} /><span>{message}</span></div>}
    <form key={step} onSubmit={step === 'email' ? sendCode : step === 'code' ? verifyCode : savePassword} className="auth-form" aria-busy={busy}>
      {step === 'email' && <label>Correo electrónico<input name="recoveryEmail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="tu@correo.com" autoComplete="email" maxLength={254} disabled={busy} required autoFocus /></label>}
      {step === 'code' && <><label>Código de verificación<input className="verification-code" name="verificationCode" type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" pattern="[0-9]{6}" minLength={6} maxLength={6} aria-describedby="code-help" disabled={busy} required autoFocus /></label><p id="code-help" className="recovery-help">El código vence en 10 minutos. Solo puedes usarlo una vez.</p></>}
      {step === 'password' && <>
        <label htmlFor="recovery-password">Nueva contraseña<PasswordInput id="recovery-password" name="newPassword" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Mínimo 8 caracteres" autoComplete="new-password" minLength={8} maxLength={128} aria-describedby="password-help" disabled={busy} required autoFocus /></label><p id="password-help" className="recovery-help">Usa al menos 8 caracteres y evita contraseñas comunes o solo numéricas.</p>
        <label htmlFor="recovery-confirm-password">Confirmar nueva contraseña<PasswordInput id="recovery-confirm-password" name="confirmNewPassword" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Repite tu nueva contraseña" autoComplete="new-password" minLength={8} maxLength={128} disabled={busy} required /></label>
        <p className="recovery-help">Por seguridad, tienes 5 minutos para guardar tu nueva contraseña después de verificar el código.</p>
      </>}
      <ErrorNotice message={error} />
      <button className="button button-primary auth-submit" disabled={busy || (step === 'code' && code.length !== 6)}>{busy ? <><LoaderCircle className="spin" size={18} /><span>Procesando…</span></> : <>{step === 'email' ? 'Enviar código de verificación' : step === 'code' ? 'Verificar código' : 'Guardar nueva contraseña'}<ArrowRight size={18} /></>}</button>
    </form>
    {step === 'code' && <div className="recovery-actions"><button type="button" className="text-button" disabled={busy || retryIn > 0} onClick={sendCode}>{retryIn > 0 ? `Reenviar código en ${retryIn} s` : 'Reenviar código'}</button><button type="button" className="text-button" disabled={busy} onClick={startOver}>Cambiar correo electrónico</button></div>}
    {step === 'password' && <div className="recovery-actions"><button type="button" className="text-button" disabled={busy} onClick={startOver}>Solicitar un nuevo código</button></div>}
    <div className="recovery-back"><button type="button" className="text-button" disabled={busy} onClick={onBack}><ChevronLeft size={16} /> Volver al inicio de sesión</button></div>
  </>;
}

function LoginVerification({ initialChallenge, onBack, onLogin }) {
  const [challenge, setChallenge] = useState(initialChallenge);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const [resendAt, setResendAt] = useState(() => Date.now() + Math.max(0, Number(initialChallenge.retry_after) || 0) * 1000);
  const [expiresAt, setExpiresAt] = useState(() => Date.now() + (Number(initialChallenge.expires_in) || 600) * 1000);
  const retryIn = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const expired = now >= expiresAt;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function post(path, body) {
    await api('/auth/csrf/', { checkSession: false });
    return api(`/auth/login/${path}/`, { method: 'POST', body, checkSession: false });
  }

  function applyRetry(failure) {
    const retryAfter = Number(failure.fields?.retry_after);
    if (failure.status !== 429 || !Number.isFinite(retryAfter) || retryAfter <= 0) return;
    const currentTime = Date.now();
    setNow(currentTime);
    setResendAt(currentTime + retryAfter * 1000);
  }

  async function verify(event) {
    event.preventDefault();
    if (busy || expired || code.length !== 6) return;
    setBusy(true);
    setError('');
    try {
      const result = await post('verify', { challenge_id: challenge.challenge_id, code });
      if (!result.user) throw new Error('No pudimos verificar tu acceso. Inténtalo de nuevo.');
      setCode('');
      onLogin(result.user);
    } catch (failure) {
      setError(failure.message);
      applyRetry(failure);
    } finally { setBusy(false); }
  }

  async function resend() {
    if (busy || retryIn > 0) return;
    setBusy(true);
    setError('');
    try {
      const result = await post('resend', { challenge_id: challenge.challenge_id });
      const currentTime = Date.now();
      setChallenge(result);
      setCode('');
      setNow(currentTime);
      setResendAt(currentTime + Math.max(0, Number(result.retry_after) || 0) * 1000);
      setExpiresAt(currentTime + (Number(result.expires_in) || 600) * 1000);
    } catch (failure) {
      setError(failure.message);
      applyRetry(failure);
    } finally { setBusy(false); }
  }

  return <>
    <h2>Confirma que eres tú.</h2>
    <p className="muted">Ingresa el código de 6 dígitos enviado a <strong className="recovery-email">{challenge.email_hint}</strong>. Revisa también tu carpeta de spam.</p>
    {challenge.detail && <div className="auth-status auth-status-info" role="status"><ShieldCheck size={18} /><span>{challenge.detail}</span></div>}
    <form className="auth-form" onSubmit={verify} aria-busy={busy}>
      <label htmlFor="login-verification-code">Código de autenticación<input id="login-verification-code" className="verification-code" name="loginVerificationCode" type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" pattern="[0-9]{6}" minLength={6} maxLength={6} aria-describedby="login-code-help" disabled={busy || expired} required autoFocus /></label>
      <p id="login-code-help" className="recovery-help">{expired ? 'El código venció. Solicita uno nuevo para continuar.' : 'El código vence en 10 minutos y solo puedes usarlo una vez.'}</p>
      <ErrorNotice message={error} />
      <button className="button button-primary auth-submit" disabled={busy || expired || code.length !== 6}>{busy ? <><LoaderCircle className="spin" size={18} /><span>Procesando…</span></> : <>Verificar e iniciar sesión<ArrowRight size={18} /></>}</button>
    </form>
    <div className="recovery-actions"><button type="button" className="text-button" disabled={busy || retryIn > 0} onClick={resend}>{retryIn > 0 ? `Reenviar código en ${retryIn} s` : 'Reenviar código'}</button></div>
    <p className="login-session-note">Guardaremos tu sesión en este dispositivo. Se cerrará cuando salgas de tu cuenta o inicies sesión en otro dispositivo.</p>
    <div className="recovery-back"><button type="button" className="text-button" disabled={busy} onClick={onBack}><ChevronLeft size={16} /> Volver al inicio de sesión</button></div>
  </>;
}

function AuthScreen({ onLogin, notice = '' }) {
  const [register, setRegister] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [loginChallenge, setLoginChallenge] = useState(null);
  const [passwordStatus, setPasswordStatus] = useState(null);
  const [form, setForm] = useState({ identifier: '', password: '', nombre: '', username: '', email: '', telefono: '', confirmPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = (event) => setForm({ ...form, [event.target.name]: event.target.value });
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (register && form.password !== form.confirmPassword) return setError('Las contraseñas no coinciden.');
    setBusy(true);
    try {
      await api('/auth/csrf/', { checkSession: false });
      const body = register ? { username: form.username.trim(), email: form.email.trim(), nombre: form.nombre.trim(), telefono: form.telefono.trim(), password: form.password } : { identifier: form.identifier.trim(), password: form.password };
      const result = await api(register ? '/auth/register/' : '/auth/login/', { method: 'POST', body, checkSession: false });
      setForm((current) => ({ ...current, password: '', confirmPassword: '' }));
      if (!result.verification_required || !result.challenge_id) throw new Error('No pudimos preparar la verificación de tu cuenta. Inténtalo de nuevo.');
      setPasswordStatus(null);
      setLoginChallenge(result);
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <div className="auth-layout">
    <main className="auth-form-area">
      <div className="auth-form-wrap">
        <header className="auth-heading"><h1>App Finanzas Mauricio</h1></header>
        {loginChallenge ? <LoginVerification initialChallenge={loginChallenge} onLogin={onLogin} onBack={() => { setLoginChallenge(null); setRegister(false); setError(''); setForm((current) => ({ ...current, identifier: current.identifier || current.email, password: '', confirmPassword: '' })); }} /> : recovering ? <PasswordRecovery initialEmail={form.identifier.includes('@') ? form.identifier : ''} onBack={() => { setRecovering(false); setError(''); }} onComplete={(result) => { setRecovering(false); setRegister(false); setError(''); setForm({ identifier: result.email, password: '', nombre: '', username: '', email: '', telefono: '', confirmPassword: '' }); setPasswordStatus(result); }} /> : <>
          <h2>{register ? 'Crear cuenta' : 'Inicio de sesión'}</h2>
          <p className="muted">{register ? 'Registra tus datos para crear tu cuenta.' : 'Ingresa a tu cuenta para continuar.'}</p>
          {passwordStatus && <div className={`auth-status ${passwordStatus.confirmation_email_sent ? 'auth-status-success' : 'auth-status-warning'}`} role="status">{passwordStatus.confirmation_email_sent ? <Check size={18} /> : <AlertCircle size={18} />}<span>{passwordStatus.detail}</span></div>}
          <form onSubmit={submit} className="auth-form">
            {register ? <><label>Nombre completo<input name="nombre" value={form.nombre} onChange={change} placeholder="Tu nombre completo" autoComplete="name" maxLength={150} required /></label><div className="form-grid"><label>Usuario<input name="username" value={form.username} onChange={change} placeholder="Tu usuario" autoComplete="username" maxLength={150} required /></label><label>Teléfono<input type="tel" name="telefono" value={form.telefono} onChange={change} placeholder="81 1234 5678" autoComplete="tel" maxLength={25} /></label></div><label>Correo electrónico<input type="email" name="email" value={form.email} onChange={change} placeholder="tu@correo.com" autoComplete="email" required /></label></> : <label>Correo electrónico o usuario<input name="identifier" value={form.identifier} onChange={change} placeholder="tu@correo.com o tu usuario" autoComplete="username" required autoFocus /></label>}
            <label htmlFor="auth-password">Contraseña<PasswordInput id="auth-password" name="password" value={form.password} onChange={change} placeholder={register ? 'Mínimo 8 caracteres' : 'Tu contraseña'} autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 8 : undefined} required /></label>
            {register && <label htmlFor="confirm-password">Confirmar contraseña<PasswordInput id="confirm-password" name="confirmPassword" value={form.confirmPassword} onChange={change} placeholder="Repite tu contraseña" autoComplete="new-password" required /></label>}
            <ErrorNotice message={error || (!passwordStatus && notice)} />
            <button className="button button-primary auth-submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <>{register ? 'Crear mi cuenta' : 'Entrar a mi cuenta'}<ArrowRight size={18} /></>}</button>
          </form>
          {!register && <div className="auth-forgot"><button type="button" className="text-button" disabled={busy} onClick={() => { setRecovering(true); setPasswordStatus(null); setError(''); setForm({ ...form, password: '', confirmPassword: '' }); }}>Olvidaste tu contraseña</button></div>}
          <p className="auth-switch">{register ? '¿Ya tienes una cuenta?' : '¿Aún no tienes una cuenta?'} <button className="text-button" disabled={busy} onClick={() => { setRegister(!register); setPasswordStatus(null); setError(''); setForm({ ...form, password: '', confirmPassword: '' }); }}>{register ? 'Inicia sesión' : 'Crea tu cuenta'}</button></p>
        </>}
      </div>
      <footer className="auth-footer"><span>© {new Date().getFullYear()} App Finanzas Mauricio</span><span>Inversiones simuladas · Sin dinero real</span></footer>
    </main>
  </div>;
}

function Donut({ holdings, total, compact = false }) {
  const radius = 72;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const slices = holdings.filter((holding) => Number(holding.current_value) > 0).map((holding, index) => {
    const portion = Number(total) > 0 ? Number(holding.current_value) / Number(total) : 0;
    const length = Math.max(0, portion * circumference - (portion < 1 ? 5 : 0));
    const slice = <circle key={holding.id || index} cx="100" cy="100" r={radius} fill="none" stroke={holding.stock.color || '#718f5d'} strokeWidth="21" strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset} transform="rotate(-90 100 100)"><title>{holding.stock.nombre}: {money(holding.current_value)}, {Number(holding.allocation).toFixed(1)}%</title></circle>;
    offset += portion * circumference;
    return slice;
  });
  return <div className={`donut ${compact ? 'donut-compact' : ''}`}><svg viewBox="0 0 200 200" role="img" aria-label={`Distribución del portafolio entre ${holdings.length} acciones`}><circle cx="100" cy="100" r={radius} fill="none" stroke="var(--line)" strokeWidth="21" />{slices}</svg><div className="donut-center"><span>{holdings.length}</span><small>{holdings.length === 1 ? 'activo' : 'activos'}</small></div></div>;
}

function ValueChart({ points }) {
  const [period, setPeriod] = useState('Todo');
  const chartRef = useRef(null);
  const [chartWidth, setChartWidth] = useState(700);
  useEffect(() => {
    const element = chartRef.current;
    const updateWidth = () => setChartWidth(Math.max(240, element.clientWidth));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const months = { '1M': 1, '3M': 3, '6M': 6 };
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - (months[period] || 1200));
  cutoff.setHours(0, 0, 0, 0);
  const filtered = points.filter((point) => period === 'Todo' || dateValue(point.date) >= cutoff);
  const width = chartWidth, height = 176, left = 4, right = 68, top = 12, bottom = 18;
  const values = filtered.map((point) => Number(point.value));
  const minimum = values.length ? Math.min(...values) : 0;
  const maximum = values.length ? Math.max(...values) : 0;
  const padding = Math.max((maximum - minimum) * 0.1, Math.max(Math.abs(maximum), Math.abs(minimum)) * 0.05, 1);
  const low = minimum - padding;
  const high = maximum + padding;
  const firstTime = filtered.length ? dateValue(filtered[0].date).getTime() : 0;
  const lastTime = filtered.length ? dateValue(filtered[filtered.length - 1].date).getTime() : firstTime;
  const x = (index) => left + (dateValue(filtered[index].date).getTime() - firstTime) / Math.max(1, lastTime - firstTime) * (width - left - right);
  const y = (value) => top + (high - value) / Math.max(1, high - low) * (height - top - bottom);
  const line = filtered.map((point, index) => `${index ? 'L' : 'M'} ${x(index)} ${y(Number(point.value))}`).join(' ');
  const area = filtered.length > 1 ? `${line} L ${x(filtered.length - 1)} ${height - bottom} L ${left} ${height - bottom} Z` : '';
  const labels = [0, 1, 2].map((index) => high - (high - low) * (index / 2));
  return <div className="value-chart" ref={chartRef}><div className="chart-toolbar"><span><span className="legend-dot" /> Compras menos ventas</span><div className="period-picker" aria-label="Periodo de la gráfica">{['1M', '3M', '6M', 'Todo'].map((item) => <button key={item} className={period === item ? 'selected' : ''} onClick={() => setPeriod(item)} aria-pressed={period === item}>{item}</button>)}</div></div>
    {filtered.length ? <><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Flujo neto invertido: compras acumuladas menos ingresos por ventas" preserveAspectRatio="none"><defs><linearGradient id="value-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#648854" stopOpacity="0.2" /><stop offset="100%" stopColor="#648854" stopOpacity="0" /></linearGradient></defs>{labels.map((value, index) => <g key={index}><line x1="0" x2={width - right + 4} y1={y(value)} y2={y(value)} stroke="currentColor" strokeOpacity="0.12" strokeDasharray="4 5" /><text x={width - right + 15} y={y(value) + 4} className="chart-axis">{COMPACT_NUMBER.format(value)}</text></g>)}{area && <path d={area} fill="url(#value-fill)" />}<path d={line} fill="none" stroke="#315e3f" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />{filtered.map((point, index) => <circle key={`${point.date}-${index}`} cx={x(index)} cy={y(Number(point.value))} r={index === filtered.length - 1 ? 4 : 2.5} fill="#315e3f"><title>{localDate(point.date, { year: 'numeric' })}: {money(point.value)}</title></circle>)}</svg><div className="chart-dates"><span>{localDate(filtered[0].date, { year: 'numeric' })}</span><span>{localDate(filtered[filtered.length - 1].date, { year: 'numeric' })}</span></div></> : <div className="chart-empty">Sin movimientos en este periodo.</div>}
    <p className="chart-footnote">Importes acumulados de compras menos ingresos por ventas. No representa el patrimonio ni cotizaciones históricas.</p>
  </div>;
}

const MOVEMENT_TYPES = {
  buy: { label: 'Compra', filter: 'Compras', icon: ArrowUpRight, debit: true },
  sell: { label: 'Venta', filter: 'Ventas', icon: ArrowDownLeft, debit: false },
  deposit: { label: 'Depósito', filter: 'Depósitos', icon: CirclePlus, debit: false },
  withdrawal: { label: 'Retiro', filter: 'Retiros', icon: ArrowUpFromLine, debit: true },
};
const MOVEMENT_FILTERS = [{ id: 'all', label: 'Todos' }, ...Object.entries(MOVEMENT_TYPES).map(([id, { filter }]) => ({ id, label: filter }))];

function TransactionList({ transactions, compact = false }) {
  if (!transactions.length) return <Empty icon={ArrowLeftRight} title="Todo comienza con un movimiento" text="Aquí verás tus depósitos, retiros y operaciones de inversión." />;
  return <div className={`transactions-list ${compact ? 'transactions-compact' : ''}`}>{transactions.map((transaction) => {
    const { label, icon: Icon, debit } = MOVEMENT_TYPES[transaction.tipo] || MOVEMENT_TYPES.sell;
    const isTrade = transaction.tipo === 'buy' || transaction.tipo === 'sell';
    const title = isTrade ? `${label} de ${transaction.stock_name || transaction.symbol || 'acción'}`
      : transaction.tipo === 'deposit' ? 'Depósito de saldo simulado' : transaction.descripcion || 'Retiro de saldo simulado';
    const detail = isTrade ? `${number(transaction.cantidad)} ${Number(transaction.cantidad) === 1 ? 'acción' : 'acciones'} · ${transaction.symbol}` : 'Saldo disponible';
    return <div className="transaction-row" key={transaction.id}>
      <span className={`transaction-icon transaction-${transaction.tipo}`}><Icon size={19} /></span>
      <div className="transaction-name"><strong>{title}</strong><span>{detail}<time className="transaction-date-mobile" dateTime={transaction.fecha}> · {localDateTime(transaction.fecha)}</time></span></div>
      <time className="transaction-date" dateTime={transaction.fecha}>{localDateTime(transaction.fecha)}</time>
      {!compact && <span className={`type-badge type-${transaction.tipo}`}>{label}</span>}
      <div className={`transaction-amount ${debit ? '' : 'positive'}`}><strong>{debit ? '−' : '+'}{money(transaction.monto)}</strong><small>{compact ? localDateTime(transaction.fecha) : 'Completada'}</small></div>
    </div>;
  })}</div>;
}

function Dashboard({ data, navigate, openFunds, openWithdrawal, openTrade }) {
  const { summary, holdings, recent_transactions: recent = [], chart = [], market = [] } = data;
  const firstName = (data.user.nombre || data.user.username).split(' ')[0];
  return <><div className="page-heading"><div><span className="eyebrow">TU VISIÓN, MÁS CLARA</span><h1>Un buen día para crecer<span className="heading-dot">.</span></h1><p>Hola, {firstName}. Así se ve el futuro que estás construyendo.</p></div><div className="dashboard-funds-actions"><button className="button button-outline" onClick={openWithdrawal}><ArrowUpFromLine size={17} /> Retirar fondos</button><button className="button button-primary" onClick={openFunds}><CirclePlus size={17} /> Agregar fondos</button></div></div>
    <div className="dashboard-top"><section className="wealth-card"><div className="card-overline"><span>PATRIMONIO TOTAL</span><span className="currency-tag">MXN <ChevronDown size={12} /></span></div><div className="wealth-total">{money(summary.total_equity)}<span>MXN</span></div><div className="wealth-caption"><Change value={summary.profit_percent} /><span>{money(summary.profit)} de rendimiento en tus inversiones</span></div><ValueChart points={chart} /></section>
      <section className="card distribution-card"><div className="card-header"><h2>Tu distribución</h2><button className="icon-button" onClick={() => navigate('portafolio')} aria-label="Ver portafolio completo"><ArrowUpRight size={19} /></button></div><Donut holdings={holdings} total={summary.portfolio_value} compact />{holdings.length ? <div className="allocation-legend">{holdings.slice(0, 4).map((holding) => <div key={holding.id}><span className="allocation-name"><i style={{ background: holding.stock.color }} />{holding.stock.nombre}</span><strong>{Number(holding.allocation).toFixed(1)}%</strong></div>)}{holdings.length > 4 && <button className="text-button allocation-more" onClick={() => navigate('portafolio')}>Ver los {holdings.length} activos <ArrowRight size={13} /></button>}</div> : <p className="muted small center">Tu primera inversión aparecerá aquí.</p>}</section>
    </div>
    <div className="stats-grid"><Stat icon={BriefcaseBusiness} label="Valor del portafolio" value={money(summary.portfolio_value)} detail={`${summary.assets_count} ${Number(summary.assets_count) === 1 ? 'activo en tu portafolio' : 'activos en tu portafolio'}`} /><Stat icon={Wallet} label="Disponible para invertir" value={money(summary.cash_balance)} detail="Tu próxima oportunidad empieza aquí" /><Stat icon={TrendingUp} label="Rendimiento acumulado" value={money(summary.profit)} detail={<><Change value={summary.profit_percent} plain /> sobre el capital invertido</>} positive={Number(summary.profit) >= 0} /></div>
    <section className="card market-section"><div className="card-header"><div><h2>Un vistazo al mercado</h2><p>Grandes nombres. Nuevas posibilidades.</p></div><button className="text-button" onClick={() => navigate('invertir')}>Explorar mercado <ArrowRight size={15} /></button></div><div className="market-grid">{market.slice(0, 4).map((stock) => <button className="market-stock" key={stock.id} onClick={() => openTrade(stock)}><div className="market-stock-heading"><StockMark stock={stock} /><span><strong>{stock.nombre}</strong><small>{stock.symbol}</small></span><ArrowUpRight className="market-stock-arrow" size={17} /></div><div className="market-stock-bottom"><strong>{money(stock.precio)}</strong><Change value={stock.cambio_porcentual} plain /></div></button>)}</div><div className="market-footnote"><span className="status-dot" /> Precios de ejemplo · Operaciones simuladas · MXN</div></section>
    <div className="dashboard-bottom"><section className="card activity-card"><div className="card-header"><h2>Últimos movimientos</h2><button className="text-button" onClick={() => navigate('transacciones')}>Ver todos <ArrowRight size={15} /></button></div><TransactionList transactions={recent.slice(0, 4)} compact /></section><aside className="growth-note"><span className="growth-note-icon"><Leaf size={25} /></span><span className="eyebrow">PASO A PASO, MÁS LEJOS</span><h2>Las grandes metas<br />empiezan en pequeño.</h2><p>Explora, aprende y encuentra tu manera de invertir. El mejor plan es el que entiendes.</p><button className="text-button" onClick={() => navigate('invertir')}>Da el siguiente paso <ArrowUpRight size={16} /></button><div className="growth-circles" aria-hidden="true"><i /><i /><i /></div></aside></div>
  </>;
}

function Stat({ icon: Icon, label, value, detail, positive }) {
  return <section className="card stat-card"><span className="stat-icon"><Icon size={19} /></span><div><span className="stat-label">{label}</span><strong className={positive ? 'positive' : ''}>{value}</strong><small>{detail}</small></div></section>;
}

function Portfolio({ data, navigate, openTrade }) {
  const { summary, holdings } = data;
  return <><div className="page-heading"><div><span className="eyebrow">LO QUE ESTÁS CONSTRUYENDO</span><h1>Mi portafolio<span className="heading-dot">.</span></h1><p>Cada inversión, una parte de tu futuro.</p></div><button className="button button-primary" onClick={() => navigate('invertir')}><CirclePlus size={17} /> Nueva inversión</button></div><div className="portfolio-overview"><section className="card portfolio-distribution"><Donut holdings={holdings} total={summary.portfolio_value} /><div><span className="eyebrow">VALOR ACTUAL</span><h2>{money(summary.portfolio_value)}</h2><Change value={summary.profit_percent} /><p className="muted small">Valor calculado con precios de ejemplo en MXN.</p></div></section><div className="portfolio-stats"><Stat icon={Wallet} label="Capital invertido" value={money(summary.invested)} detail="Costo de tus posiciones actuales" /><Stat icon={TrendingUp} label="Ganancia / pérdida" value={money(summary.profit)} positive={Number(summary.profit) >= 0} detail="Sin realizar · según precios de ejemplo" /></div></div>
    <section className="card"><div className="card-header"><h2>Tus inversiones <span className="count-pill">{holdings.length}</span></h2><span className="muted small">Distribución por valor actual</span></div>{holdings.length ? <><p className="mobile-table-hint">Desliza la tabla para ver todos los detalles y operar.</p><div className="table-scroll" tabIndex={0} role="region" aria-label="Tus inversiones: tabla con desplazamiento horizontal"><table className="holdings-table"><thead><tr><th>Activo</th><th>Cantidad</th><th>Valor actual</th><th>Rendimiento</th><th>Distribución</th><th><span className="sr-only">Operar</span></th></tr></thead><tbody>{holdings.map((holding) => <tr key={holding.id}><td><div className="stock-name"><StockMark stock={holding.stock} /><span><strong>{holding.stock.nombre}</strong><small>{holding.stock.symbol}</small></span></div></td><td><strong>{number(holding.quantity)}</strong><small>{money(holding.stock.precio)} / acción</small></td><td><strong>{money(holding.current_value)}</strong><small>{money(holding.invested)} invertidos</small></td><td><strong className={Number(holding.profit) >= 0 ? 'positive' : 'negative'}>{money(holding.profit)}</strong><Change value={holding.profit_percent} plain /></td><td><div className="allocation-bar"><span style={{ width: `${Math.min(100, Number(holding.allocation))}%`, background: holding.stock.color }} /></div><small>{Number(holding.allocation).toFixed(1)}%</small></td><td><div className="holding-actions"><button className="button button-outline button-small" aria-label={`Comprar ${holding.stock.nombre}`} onClick={() => openTrade(holding.stock, 'buy')}>Comprar</button><button className="button button-primary button-small" aria-label={`Vender ${holding.stock.nombre}`} onClick={() => openTrade(holding.stock, 'sell')}>Vender <ArrowUpRight size={14} /></button></div></td></tr>)}</tbody></table></div></> : <Empty title="Tu portafolio está por comenzar" text="Encuentra una empresa que conozcas y realiza tu primera inversión simulada." action={<button className="button button-primary" onClick={() => navigate('invertir')}>Explorar acciones <ArrowRight size={16} /></button>} />}</section>
  </>;
}

function Market({ stocks, openTrade, balance }) {
  const [search, setSearch] = useState('');
  const [sector, setSector] = useState('Todos');
  const [sort, setSort] = useState('nombre');
  const sectors = ['Todos', ...new Set(stocks.map((stock) => stock.sector).filter(Boolean))];
  const filtered = stocks.filter((stock) => (`${stock.nombre} ${stock.symbol}`).toLocaleLowerCase().includes(search.toLocaleLowerCase()) && (sector === 'Todos' || stock.sector === sector)).sort((a, b) => sort === 'precio' ? Number(a.precio) - Number(b.precio) : sort === 'cambio' ? Number(b.cambio_porcentual) - Number(a.cambio_porcentual) : a.nombre.localeCompare(b.nombre));
  return <><div className="page-heading"><div><span className="eyebrow">BOLSA MEXICANA DE VALORES</span><h1>Invierte en México<span className="heading-dot">.</span></h1><p>Explora empresas de la BMV y practica con saldo simulado.</p></div><div className="available-balance"><Wallet size={18} /><span>Disponible<strong>{money(balance)}</strong></span></div></div><section className="card market-page-card"><div className="market-filters"><label className="search-field"><Search size={18} /><input type="search" placeholder="Buscar por empresa o símbolo…" aria-label="Buscar acciones" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label className="sort-select"><SlidersHorizontal size={16} /><span className="sr-only">Ordenar acciones</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="nombre">Nombre: A — Z</option><option value="precio">Menor precio</option><option value="cambio">Mayor variación</option></select></label></div><div className="sector-tabs" aria-label="Filtrar por sector">{sectors.map((item) => <button key={item} className={item === sector ? 'selected' : ''} onClick={() => setSector(item)} aria-pressed={item === sector}>{item}</button>)}</div><div className="market-result-count">{filtered.length} {filtered.length === 1 ? 'empresa' : 'empresas'} de la BMV para explorar</div>{filtered.length ? <div className="stock-cards">{filtered.map((stock) => <article className="stock-card" key={stock.id}><div className="stock-card-top"><StockMark stock={stock} /><span className="stock-sector">{stock.sector}</span></div><h2>{stock.nombre}</h2><span className="stock-symbol">{stock.symbol}</span><div className="stock-card-value"><strong>{money(stock.precio)}</strong><Change value={stock.cambio_porcentual} /></div><div className="stock-card-bottom"><span>Precio de ejemplo · MXN</span><button className="button button-outline button-small" onClick={() => openTrade(stock)}>Invertir <ArrowUpRight size={14} /></button></div></article>)}</div> : <Empty icon={Search} title="No encontramos esa empresa" text="Prueba otro nombre, símbolo o sector." action={<button className="text-button" onClick={() => { setSearch(''); setSector('Todos'); }}>Limpiar filtros</button>} />}</section><div className="info-strip"><CircleHelp size={19} /><p><strong>Un espacio para aprender.</strong> Los precios y cambios porcentuales son datos de ejemplo, no cotizaciones actuales. Todas las operaciones son simuladas.</p></div></>;
}

function Transactions({ transactions }) {
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const filtered = transactions.filter((transaction) => {
    const day = new Date(transaction.fecha).toLocaleDateString('sv-SE');
    return (type === 'all' || transaction.tipo === type) && (!start || day >= start) && (!end || day <= end) && `${transaction.descripcion} ${transaction.stock_name || ''} ${transaction.symbol || ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  });
  function exportCsv() {
    const cell = (value) => `"${String(value ?? '').replace(/^[=+\-@\t\r]/, "'").replaceAll('"', '""')}"`;
    const csv = [['Fecha', 'Tipo', 'Descripción', 'Símbolo', 'Cantidad', 'Precio unitario MXN', 'Monto MXN'], ...filtered.map((transaction) => [transaction.fecha, transaction.tipo, transaction.descripcion, transaction.symbol, transaction.cantidad, transaction.precio_unitario, transaction.monto])].map((row) => row.map(cell).join(',')).join('\r\n');
    const objectUrl = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = `app-finanzas-mauricio-transacciones-${new Date().toLocaleDateString('sv-SE')}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
  return <><div className="page-heading"><div><span className="eyebrow">CADA PASO CUENTA</span><h1>Tus movimientos, claros<span className="heading-dot">.</span></h1><p>El recorrido de tus decisiones, en un solo lugar.</p></div><button className="button button-outline" onClick={exportCsv} disabled={!filtered.length}><ArrowDownToLine size={17} /> Exportar CSV</button></div><section className="card transactions-page"><div className="transactions-filters"><label className="search-field"><Search size={18} /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar movimiento…" aria-label="Buscar transacciones" /></label><label>Desde<input type="date" value={start} max={end || undefined} onChange={(event) => setStart(event.target.value)} /></label><label>Hasta<input type="date" value={end} min={start || undefined} onChange={(event) => setEnd(event.target.value)} /></label></div><div className="transaction-tabs">{MOVEMENT_FILTERS.map((item) => <button className={type === item.id ? 'selected' : ''} key={item.id} onClick={() => setType(item.id)} aria-pressed={type === item.id}>{item.label}</button>)}<span>{filtered.length} {filtered.length === 1 ? 'movimiento' : 'movimientos'}</span></div>{filtered.length ? <TransactionList transactions={filtered} /> : <Empty icon={ArrowLeftRight} title={transactions.length ? 'Sin resultados para estos filtros' : 'Aún no hay movimientos'} text={transactions.length ? 'Prueba otra búsqueda o amplía el periodo.' : 'Aquí verás tus depósitos, retiros y operaciones de inversión.'} action={transactions.length ? <button className="text-button" onClick={() => { setSearch(''); setType('all'); setStart(''); setEnd(''); }}>Limpiar filtros</button> : undefined} />}</section></>;
}

function Settings({ user, onSave, onLogout }) {
  const [form, setForm] = useState({ nombre: user.nombre, email: user.email, telefono: user.telefono || '', notifications: user.notifications, dark_mode: user.dark_mode });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const update = (event) => { setForm({ ...form, [event.target.name]: event.target.value }); setSaved(false); };
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setError(''); setSaved(false); setBusy(true);
    try { const result = await api('/auth/me/', { method: 'PATCH', body: form }); onSave(result.user); setSaved(true); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <><div className="page-heading"><div><span className="eyebrow">TU ESPACIO, A TU MANERA</span><h1>Configuración<span className="heading-dot">.</span></h1><p>Los detalles que hacen que App Finanzas Mauricio sea tuyo.</p></div></div><form className="settings-layout" onSubmit={save}><section className="card profile-card"><div className="card-header"><h2>Información personal</h2><span className="profile-avatar">{initials(user.nombre)}</span></div><p className="muted">Mantén tus datos actualizados.</p><div className="settings-fields"><label>Nombre completo<input name="nombre" value={form.nombre} onChange={update} autoComplete="name" maxLength={150} required /></label><label>Nombre de usuario<input value={user.username} disabled autoComplete="username" /><small>Tu identificador de acceso.</small></label><label>Correo electrónico<input type="email" name="email" value={form.email} onChange={update} autoComplete="email" required /></label><label>Teléfono<input type="tel" name="telefono" value={form.telefono} onChange={update} autoComplete="tel" maxLength={25} /></label></div><ErrorNotice message={error} /><div className="settings-save"><button className="button button-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} Guardar cambios</button>{saved && <span className="saved-message" role="status"><Check size={16} /> Cambios guardados</span>}</div></section><div className="settings-side"><section className="card preferences-card"><h2>Preferencias</h2><div className="preference-row"><span className="preference-icon"><Moon size={19} /></span><div><strong>Tema oscuro</strong><p>Una vista más suave por la noche.</p></div><button className={`toggle ${form.dark_mode ? 'active' : ''}`} role="switch" aria-checked={Boolean(form.dark_mode)} aria-label="Tema oscuro" type="button" onClick={() => { setForm({ ...form, dark_mode: !form.dark_mode }); setSaved(false); }}><span /></button></div><div className="preference-row"><span className="preference-icon"><Sparkles size={19} /></span><div><strong>Notificaciones</strong><p>Guardar mi preferencia de avisos.</p></div><button className={`toggle ${form.notifications ? 'active' : ''}`} role="switch" aria-checked={Boolean(form.notifications)} aria-label="Notificaciones" type="button" onClick={() => { setForm({ ...form, notifications: !form.notifications }); setSaved(false); }}><span /></button></div><p className="preference-footnote">Aplica tus preferencias con «Guardar cambios». La preferencia de avisos no activa correos ni notificaciones del navegador.</p></section><section className="card session-card"><ShieldCheck size={25} /><h2>Una sesión personal</h2><p className="muted">Tus inversiones y movimientos solo están disponibles en tu cuenta.</p><button type="button" className="text-button logout-text" onClick={onLogout}><LogOut size={16} /> Cerrar sesión</button></section></div></form><CardManager user={user} Modal={Modal} /></>;
}

function Modal({ title, subtitle, children, onClose, busy }) {
  const element = useRef(null);
  const previous = useRef(null);
  useEffect(() => {
    previous.current = document.activeElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusables = () => Array.from(element.current?.querySelectorAll('button:not([disabled]),input:not([disabled]),select,a[href],[tabindex="0"]') || []);
    focusables()[0]?.focus();
    function keydown(event) {
      if (event.key === 'Escape' && !busy) onClose();
      if (event.key === 'Tab') {
        const items = focusables();
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener('keydown', keydown); previous.current?.focus(); };
  }, [onClose, busy]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={element}><div className="modal-header"><div><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="Cerrar ventana"><X size={20} /></button></div>{children}</section></div>;
}

function TradeModal({ stock, holding, balance, initialSide = 'buy', onClose, onComplete }) {
  const [side, setSide] = useState(initialSide);
  const [quantity, setQuantity] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const validQuantity = Number.isFinite(Number(quantity)) && Number(quantity) > 0 && /^\d+(\.\d{1,6})?$/.test(quantity);
  const quantityUnits = validQuantity ? decimalUnits(quantity, 6) : null;
  const priceCents = decimalUnits(stock.precio, 2);
  const totalCents = quantityUnits !== null && priceCents !== null ? (quantityUnits * priceCents + 500000n) / 1000000n : null;
  const total = totalCents === null ? 0 : Number(totalCents) / 100;
  const over = validQuantity && (side === 'buy' ? totalCents > (decimalUnits(balance, 2) || 0n) : quantityUnits > (decimalUnits(holding?.quantity || '0', 6) || 0n));
  const belowMinimum = validQuantity && totalCents === 0n;
  async function submit(event) {
    event.preventDefault();
    if (busy || !validQuantity || over || belowMinimum || totalCents === null) return;
    setError(''); setBusy(true);
    try { await api('/trades/', { method: 'POST', body: { stock_id: stock.id, side, quantity } }); await onComplete(`${side === 'buy' ? 'Compra' : 'Venta'} simulada de ${stock.nombre} realizada.`); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <Modal title="Un paso hacia adelante" subtitle="Operación con saldo simulado" onClose={onClose} busy={busy}><form onSubmit={submit}><div className="trade-stock"><StockMark stock={stock} /><div><strong>{stock.nombre}</strong><small>{stock.symbol} <Change value={stock.cambio_porcentual} plain /></small></div><strong>{money(stock.precio)}<small>por acción · MXN</small></strong></div><div className="trade-tabs"><button type="button" className={side === 'buy' ? 'selected' : ''} onClick={() => { setSide('buy'); setError(''); }}>Comprar</button><button type="button" className={side === 'sell' ? 'selected' : ''} onClick={() => { setSide('sell'); setError(''); }}>Vender</button></div><label className="trade-quantity">Cantidad de acciones<input type="number" min="0.000001" step="0.000001" required value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="decimal" /><small>Admite hasta 6 decimales.</small></label><div className="trade-summary"><div><span>{side === 'buy' ? 'Saldo disponible' : 'Acciones en tu portafolio'}</span><strong>{side === 'buy' ? money(balance) : number(holding?.quantity)}</strong></div><div><span>{side === 'buy' ? 'Total de la compra' : 'Total de la venta'}</span><strong>{money(Number.isFinite(total) ? total : 0)}</strong></div></div>{validQuantity && over && <ErrorNotice message={side === 'buy' ? 'El saldo disponible no es suficiente para esta compra.' : 'No tienes suficientes acciones para esta venta.'} />}<ErrorNotice message={belowMinimum ? 'El importe mínimo de una operación es $0.01 MXN. Aumenta la cantidad de acciones.' : error} /><p className="trade-disclaimer"><ShieldCheck size={16} /> Operación simulada. El precio se confirma en el servidor al enviar la orden.</p><button className="button button-primary full-width" disabled={busy || !validQuantity || over || belowMinimum || totalCents === null}>{busy ? <LoaderCircle className="spin" size={18} /> : <>{side === 'buy' ? 'Confirmar compra' : 'Confirmar venta'} <ArrowRight size={17} /></>}</button></form></Modal>;
}

function Sidebar({ user, page, navigate, onLogout, isOpen, onClose }) {
  return <>
    <div className={`sidebar-scrim ${isOpen ? 'visible' : ''}`} onClick={onClose} />
    <aside className={`sidebar ${isOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-brand">
        <Logo />
        <button className="icon-button mobile-close" onClick={onClose} aria-label="Cerrar menú"><X size={21} /></button>
      </div>
      <span className="sidebar-overline">TU ESPACIO FINANCIERO</span>
      <nav aria-label="Navegación principal">
        {NAV.map(({ id, title, icon: Icon }) => <a key={id} href={`#${id}`} className={page === id ? 'active' : ''} onClick={() => navigate(id)} aria-current={page === id ? 'page' : undefined}>
          <Icon size={19} />
          <span>{title}</span>
          {page === id && <span className="nav-active-dot" />}
        </a>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-user">
          <span className="sidebar-avatar">{initials(user.nombre)}</span>
          <span><strong>{(user.nombre || user.username).split(' ').slice(0, 2).join(' ')}</strong><small>Cuenta personal</small></span>
          <button className="icon-button" onClick={onLogout} aria-label="Cerrar sesión"><LogOut size={17} /></button>
        </div>
      </div>
    </aside>
  </>;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [initError, setInitError] = useState('');
  const [page, setPage] = useState(pageFromHash);
  const [menu, setMenu] = useState(false);
  const [data, setData] = useState(null);
  const [stocks, setStocks] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState('');
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [authNotice, setAuthNotice] = useState('');
  const generation = useRef(0);
  const initialization = useRef(0);

  const resetSession = useCallback((expired = false) => {
    generation.current++;
    initialization.current++;
    setUser(null); setData(null); setStocks([]); setTransactions([]);
    setModal(null); setMenu(false); setError(''); setToast('');
    setLoading(false); setLogoutBusy(false); setInitializing(false);
    setPage('inicio'); location.hash = '';
    setAuthNotice(expired ? 'Tu sesión terminó o se inició sesión en otro dispositivo. Inicia sesión de nuevo para continuar.' : '');
  }, []);
  useEffect(() => {
    const onExpired = () => resetSession(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [resetSession]);

  const finishLogin = useCallback((account) => {
    initialization.current++;
    generation.current++;
    setAuthNotice(''); setError(''); setUser(account);
  }, []);

  const initialize = useCallback(async () => {
    const current = ++initialization.current;
    setInitializing(true); setInitError('');
    try { const account = await initializeSession(); if (current === initialization.current) setUser(account); }
    catch (failure) { if (current === initialization.current) setInitError(failure.message); }
    finally { if (current === initialization.current) setInitializing(false); }
  }, []);
  useEffect(() => { initialize(); }, [initialize]);
  useEffect(() => {
    const onHash = () => { setPage(pageFromHash()); setMenu(false); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = user?.dark_mode ? 'dark' : 'light'; }, [user?.dark_mode]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5500); return () => clearTimeout(timer); }, [toast]);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError('');
    try {
      const [dashboard, market, movements] = await Promise.all([api('/dashboard/'), api('/stocks/'), api('/transactions/')]);
      if (current !== generation.current) return;
      setData(dashboard); setStocks(Array.isArray(market) ? market : market.results || []); setTransactions(Array.isArray(movements) ? movements : movements.results || []); setUser(dashboard.user);
    } catch (failure) {
      if (current !== generation.current) return;
      if (failure.sessionExpired) resetSession(true);
      else { setError(failure.message); throw failure; }
    } finally { if (current === generation.current) setLoading(false); }
  }, [resetSession]);
  useEffect(() => { if (user?.id) refresh().catch(() => {}); }, [user?.id, page, refresh]);
  useEffect(() => {
    if (!user?.id) return;
    const onFocus = () => refresh().catch(() => {});
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [user?.id, refresh]);

  const navigate = useCallback((id) => { location.hash = id; setPage(id); setMenu(false); window.scrollTo(0, 0); }, []);
  const closeModal = useCallback(() => setModal(null), []);
  async function logout() {
    if (logoutBusy) return;
    setLogoutBusy(true);
    try { await api('/auth/logout/', { method: 'POST' }); resetSession(); }
    catch (failure) { if (!failure.sessionExpired) setError(failure.message); }
    finally { setLogoutBusy(false); }
  }
  async function complete(message) {
    setModal(null); setToast(message);
    try { await refresh(); }
    catch { setToast(`${message} Actualiza la vista para consultar el saldo más reciente.`); }
  }

  if (initializing) return <div className="boot-screen"><Logo dark /><Loading /></div>;
  if (initError) return <div className="boot-screen"><Logo dark /><div className="connection-error"><h1>Tu espacio te espera.</h1><p>Necesitamos conectar con el servidor para continuar.</p><ErrorNotice message={initError} /><button className="button button-primary" onClick={initialize}>Volver a conectar <ArrowRight size={17} /></button></div></div>;
  if (!user) return <AuthScreen onLogin={finishLogin} notice={authNotice} />;

  return <div className="app-layout"><a href="#main-content" className="skip-link" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Saltar al contenido</a><Sidebar user={user} page={page} navigate={navigate} onLogout={logout} isOpen={menu} onClose={() => setMenu(false)} /><div className="main-shell"><header className="topbar"><div className="topbar-location"><button className="icon-button menu-button" onClick={() => setMenu(true)} aria-label="Abrir menú de navegación"><Menu size={22} /></button><span className="topbar-home">Mi espacio</span><ChevronRight size={13} /><strong>{NAV.find((item) => item.id === page)?.title}</strong></div><div className="topbar-right"><span className="simulation-badge"><span /> Mercado simulado</span><span className="topbar-divider" /><button className="topbar-profile" onClick={() => navigate('configuracion')} aria-label="Ver configuración de mi cuenta"><span className="topbar-avatar">{initials(user.nombre)}</span><span>{(user.nombre || user.username).split(' ')[0]} <ChevronDown size={13} /></span></button></div></header><main id="main-content" className="main-content" tabIndex="-1"><ErrorNotice message={error} onRetry={() => refresh().catch(() => {})} />{!data && loading ? <Loading label="Ponemos tus números en perspectiva…" /> : data ? <div className={loading ? 'content-refreshing' : ''} aria-busy={loading}>{page === 'inicio' && <Dashboard data={{ ...data, user }} navigate={navigate} openFunds={() => setModal({ type: 'funds' })} openWithdrawal={() => setModal({ type: 'withdrawal' })} openTrade={(stock) => setModal({ type: 'trade', stock })} />}{page === 'portafolio' && <Portfolio data={data} navigate={navigate} openTrade={(stock, side) => setModal({ type: 'trade', stock, side })} />}{page === 'invertir' && <Market stocks={stocks} balance={data.summary.cash_balance} openTrade={(stock) => setModal({ type: 'trade', stock })} />}{page === 'transacciones' && <Transactions transactions={transactions} />}{page === 'configuracion' && <Settings user={user} onSave={(updated) => { setUser(updated); setToast('Tu perfil y preferencias se guardaron.'); }} onLogout={logout} />}</div> : !error ? <Loading /> : null}<footer className="app-footer"><span>App Finanzas Mauricio <span>Invierte en entender tu futuro.</span></span><span><ShieldCheck size={13} /> Entorno simulado · Sin dinero real</span></footer></main></div>{toast && <div className="toast" role="status"><span><Check size={17} /></span>{toast}<button className="icon-button" onClick={() => setToast('')} aria-label="Cerrar aviso"><X size={16} /></button></div>}{logoutBusy && <div className="logout-overlay" role="status"><LoaderCircle size={22} className="spin" /> Cerrando sesión…</div>}{modal?.type === 'trade' && data && <TradeModal stock={modal.stock} initialSide={modal.side || 'buy'} holding={data.holdings.find((holding) => holding.stock.id === modal.stock.id)} balance={data.summary.cash_balance} onClose={closeModal} onComplete={complete} />}{modal?.type === 'funds' && data && <StripeFundsModal userId={user.id} balance={data.summary.cash_balance} Modal={Modal} onClose={closeModal} onComplete={complete} onManageCards={() => { setModal(null); navigate('configuracion'); }} />}{modal?.type === 'withdrawal' && data && <WithdrawalModal userId={user.id} Modal={Modal} onClose={closeModal} onComplete={() => refresh().catch(() => {})} onAddFunds={() => setModal({ type: 'funds' })} onViewTransactions={() => { closeModal(); navigate('transacciones'); }} />}</div>;
}
