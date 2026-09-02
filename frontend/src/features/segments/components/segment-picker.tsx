import { useSegments } from "../api";

type Props = {
  value: string | undefined;
  onChange: (segmentId: string | undefined) => void;
  /** Label shown for the "no segment selected" option. */
  placeholder?: string;
  id?: string;
  disabled?: boolean;
};

/**
 * A select over saved segments. Native <select> so it degrades gracefully and
 * is trivially reusable (the campaign audience step reuses it to load a saved
 * segment's filters).
 */
export function SegmentPicker({
  value,
  onChange,
  placeholder = "Selecione um segmento",
  id,
  disabled,
}: Props) {
  const { data: segments, isLoading } = useSegments();

  return (
    <select
      id={id}
      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      value={value ?? ""}
      disabled={disabled || isLoading}
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">{placeholder}</option>
      {segments?.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
