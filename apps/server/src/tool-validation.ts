import Ajv, { type ValidateFunction } from "ajv";

/** Ajv retains generated functions even after removeSchema(). Evict the entire
 * compiler with its validator, rather than sharing an ever-growing compiler. */
export class ToolValidatorCache {
  private readonly entries = new Map<string, { compiler: Ajv; validate: ValidateFunction }>();
  constructor(private readonly limit = 128) {}
  get size(): number { return this.entries.size; }
  get(schema: Record<string, unknown>): ValidateFunction {
    const key = JSON.stringify(schema);
    let entry = this.entries.get(key);
    if (entry) this.entries.delete(key);
    else {
      const compiler = new Ajv({ allErrors: true, strict: false });
      entry = { compiler, validate: compiler.compile(schema) };
    }
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return entry.validate;
  }
}

export const toolValidators = new ToolValidatorCache();
const errors = new Ajv({ allErrors: true, strict: false });
export const validationErrors = errors.errorsText.bind(errors);
export function validateToolInput(name: string, schema: Record<string, unknown>, input: Record<string, unknown>): void {
  const validate = toolValidators.get(schema);
  if (!validate(input)) throw new Error(`Invalid tool arguments for ${name}: ${errors.errorsText(validate.errors)}`);
}
