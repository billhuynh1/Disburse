'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Popover } from 'radix-ui';
import { cn } from '@/lib/utils';

export type SingleSelectPickerOption = {
  value: string;
  label: string;
  description?: string;
};

type SingleSelectPickerProps = {
  className?: string;
  disabled?: boolean;
  emptyMessage?: string;
  id?: string;
  name?: string;
  onValueChange: (value: string) => void;
  options: SingleSelectPickerOption[];
  placeholder: string;
  required?: boolean;
  value: string;
  'aria-invalid'?: boolean;
};

export function SingleSelectPicker({
  className,
  disabled = false,
  emptyMessage = 'No options available.',
  id,
  name,
  onValueChange,
  options,
  placeholder,
  required = false,
  value,
  'aria-invalid': ariaInvalid,
}: SingleSelectPickerProps) {
  const generatedId = useId();
  const pickerId = id ?? `single-select-picker-${generatedId}`;
  const [open, setOpen] = useState(false);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedOption = options.find((option) => option.value === value) ?? null;
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  useEffect(() => {
    if (!open) {
      setHighlightedIndex(-1);
      return;
    }

    if (options.length === 0) {
      setHighlightedIndex(-1);
      return;
    }

    const selectedIndex = options.findIndex(
      (option) => option.value === value
    );

    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, options, value]);

  useEffect(() => {
    if (highlightedIndex < 0) {
      return;
    }

    optionRefs.current[highlightedIndex]?.scrollIntoView({
      block: 'nearest',
    });
    optionRefs.current[highlightedIndex]?.focus();
  }, [highlightedIndex]);

  function moveHighlightedIndex(direction: -1 | 1) {
    if (options.length === 0) {
      return;
    }

    setHighlightedIndex((currentIndex) => {
      if (currentIndex < 0) {
        return direction === 1 ? 0 : options.length - 1;
      }

      return (currentIndex + direction + options.length) % options.length;
    });
  }

  function handleSelect(nextValue: string) {
    onValueChange(nextValue);
    setOpen(false);
  }

  function handleListKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveHighlightedIndex(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlightedIndex(-1);
      return;
    }

    if (event.key === 'Enter') {
      if (highlightedIndex < 0 || !options[highlightedIndex]) {
        return;
      }

      event.preventDefault();
      handleSelect(options[highlightedIndex].value);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className={cn('relative', className)}>
        {name ? (
          <input
            aria-hidden="true"
            autoComplete="off"
            className="pointer-events-none absolute size-0 opacity-0"
            name={name}
            onChange={() => undefined}
            tabIndex={-1}
            value={value}
          />
        ) : null}

        <Popover.Trigger asChild>
          <button
            aria-controls={`${pickerId}-content`}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-invalid={ariaInvalid}
            aria-required={required}
            className={cn(
              'border-input flex h-10 w-full min-w-0 cursor-pointer items-center justify-between rounded-xl border bg-input/55 px-3 py-2 text-left text-base shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-[color,box-shadow,border-color,background-color] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
              'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
              'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive'
            )}
            disabled={disabled}
            id={pickerId}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setOpen(true);
                return;
              }

              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setOpen(true);
              }
            }}
            type="button"
          >
            <span
              className={cn(
                'truncate',
                selectedOption ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {selectedOption?.label || placeholder}
            </span>
            <ChevronDown
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                open && 'rotate-180'
              )}
            />
          </button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            align="start"
            className="bg-popover/95 text-popover-foreground z-50 w-[var(--radix-popover-trigger-width)] rounded-2xl border border-border/80 p-2 shadow-[0_18px_42px_rgba(8,10,24,0.5)] backdrop-blur-md outline-none"
            id={`${pickerId}-content`}
            sideOffset={8}
          >
            <div
              className="max-h-64 overflow-y-auto"
              onKeyDown={handleListKeyDown}
              role="listbox"
            >
              {options.length === 0 ? (
                <p className="px-3 py-6 text-sm text-muted-foreground">
                  {emptyMessage}
                </p>
              ) : (
                options.map((option, index) => {
                  const isSelected = option.value === value;
                  const isHighlighted = index === highlightedIndex;

                  return (
                    <button
                      aria-selected={isSelected}
                      className={cn(
                        'flex w-full cursor-pointer items-start justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-foreground transition-colors outline-none hover:bg-accent/70 focus-visible:bg-accent/70',
                        isHighlighted && 'bg-accent/70'
                      )}
                      key={option.value}
                      onClick={() => handleSelect(option.value)}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      ref={(element) => {
                        optionRefs.current[index] = element;
                      }}
                      role="option"
                      type="button"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                          {option.label}
                        </span>
                        {option.description ? (
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                      <Check
                        className={cn(
                          'mt-0.5 h-4 w-4 shrink-0',
                          isSelected ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </button>
                  );
                })
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </div>
    </Popover.Root>
  );
}
