import { useRef } from 'react';

interface Props {
  disabled?: boolean;
  onSend: (data: Uint8Array) => void;
}

export function InputBar({ disabled, onSend }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const input = inputRef.current;
    console.log('[InputBar] submit called, disabled:', disabled, 'value:', input?.value);
    if (!input) return;
    const value = input.value;
    if (!value || disabled) {
      console.log('[InputBar] early return: empty or disabled');
      return;
    }
    const bytes = new TextEncoder().encode(value + '\r');
    console.log('[InputBar] calling onSend with bytes:', bytes.length);
    onSend(bytes);
    input.value = '';
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="terminal-input-bar">
      <input
        ref={inputRef}
        placeholder={disabled ? 'Session has exited' : 'Type a command and press Enter…'}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        onKeyDown={onKeyDown}
      />
      <button type="button" disabled={disabled} onClick={submit}>Send</button>
    </div>
  );
}
