export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  disabled?: boolean;
  multiline?: boolean;
  /** Hides typed characters (e.g. seed word grids). */
  masked?: boolean;
}

/** Controlled input — value in, change event out; no local state. */
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  disabled,
  multiline,
  masked,
}: TextFieldProps) {
  const inputId = `sovl-field-${slug(label)}`;
  return (
    <div className="sovl-field">
      <label className="sovl-label" htmlFor={inputId}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={inputId}
          className="sovl-input"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          rows={4}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={inputId}
          className="sovl-input"
          type={masked ? 'password' : 'text'}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {error ? <span className="sovl-error">{error}</span> : null}
      {hint ? <span className="sovl-hint">{hint}</span> : null}
    </div>
  );
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
