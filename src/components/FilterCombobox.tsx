import { Combobox } from '@base-ui/react/combobox';
import { Check, ChevronDown, X } from 'lucide-react';

// Generic single-select combobox: a text input that filters a list as you
// type, backed by Base UI's headless Combobox primitive. Unstyled by Base UI —
// the `.combobox-*` classes in styles.css give it the same pill/popup look as
// the native `.select-wrap` controls it replaces.
interface FilterComboboxProps<T> {
  items: T[];
  value: T | null;
  onValueChange: (value: T) => void;
  // Drives both the rendered label and Base UI's built-in text filtering.
  itemToLabel: (item: T) => string;
  // Stable React key per item; defaults to the label.
  itemToKey?: (item: T) => string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  emptyMessage?: string;
  // Show an inline clear (×) button. Off by default — branch fields always
  // need a value, so clearing to null is only useful for the repo picker.
  showClear?: boolean;
  'data-testid'?: string;
}

export function FilterCombobox<T>({
  items,
  value,
  onValueChange,
  itemToLabel,
  itemToKey,
  placeholder = 'Filter…',
  ariaLabel,
  disabled,
  emptyMessage = 'No matches',
  showClear = false,
  'data-testid': dataTestid,
}: FilterComboboxProps<T>) {
  const keyOf = itemToKey ?? itemToLabel;
  return (
    <Combobox.Root
      items={items}
      value={value}
      // Single-select Clear emits null; ignore it so the field keeps its value.
      onValueChange={(next) => {
        if (next != null) onValueChange(next);
      }}
      itemToStringLabel={itemToLabel}
      disabled={disabled}
    >
      <Combobox.InputGroup className="combobox-input-group">
        <Combobox.Input
          className="combobox-input"
          placeholder={placeholder}
          aria-label={ariaLabel}
          data-testid={dataTestid}
        />
        {showClear && (
          <Combobox.Clear className="combobox-icon-btn" aria-label="Clear">
            <X size={14} />
          </Combobox.Clear>
        )}
        <Combobox.Trigger className="combobox-icon-btn" aria-label="Open list">
          <ChevronDown size={15} />
        </Combobox.Trigger>
      </Combobox.InputGroup>

      <Combobox.Portal>
        <Combobox.Positioner className="combobox-positioner" sideOffset={4}>
          <Combobox.Popup className="combobox-popup">
            <Combobox.Empty className="combobox-empty">{emptyMessage}</Combobox.Empty>
            <Combobox.List className="combobox-list">
              {(item: T) => (
                <Combobox.Item key={keyOf(item)} value={item} className="combobox-item">
                  <span className="combobox-item-label">{itemToLabel(item)}</span>
                  <Combobox.ItemIndicator className="combobox-item-indicator">
                    <Check size={14} />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
