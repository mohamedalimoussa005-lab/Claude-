import type { CustomerInfo } from "../../booking/types";
import "./reservation.css";

export type CustomerErrors = Partial<Record<keyof CustomerInfo, string>>;

interface DetailsStepProps {
  value: CustomerInfo;
  errors: CustomerErrors;
  onChange: (field: keyof CustomerInfo, value: string) => void;
}

export function DetailsStep({ value, errors, onChange }: DetailsStepProps) {
  return (
    <div className="rsv-step">
      <p className="eyebrow">Étape 04</p>
      <h1 className="rsv-step__title">Vos coordonnées.</h1>

      <form className="rsv-form" onSubmit={(e) => e.preventDefault()}>
        <div className="rsv-form__row">
          <label className="rsv-field">
            <span className="rsv-field__label">Prénom</span>
            <input
              type="text"
              value={value.firstName}
              onChange={(e) => onChange("firstName", e.target.value)}
              autoComplete="given-name"
              className={errors.firstName ? "rsv-field__input--error" : ""}
            />
            {errors.firstName && <span className="rsv-field__error">{errors.firstName}</span>}
          </label>

          <label className="rsv-field">
            <span className="rsv-field__label">Nom</span>
            <input
              type="text"
              value={value.lastName}
              onChange={(e) => onChange("lastName", e.target.value)}
              autoComplete="family-name"
              className={errors.lastName ? "rsv-field__input--error" : ""}
            />
            {errors.lastName && <span className="rsv-field__error">{errors.lastName}</span>}
          </label>
        </div>

        <label className="rsv-field">
          <span className="rsv-field__label">Téléphone</span>
          <input
            type="tel"
            value={value.phone}
            onChange={(e) => onChange("phone", e.target.value)}
            autoComplete="tel"
            placeholder="06 12 34 56 78"
            className={errors.phone ? "rsv-field__input--error" : ""}
          />
          {errors.phone && <span className="rsv-field__error">{errors.phone}</span>}
        </label>

        <label className="rsv-field">
          <span className="rsv-field__label">Email (optionnel)</span>
          <input
            type="email"
            value={value.email ?? ""}
            onChange={(e) => onChange("email", e.target.value)}
            autoComplete="email"
            placeholder="vous@exemple.com"
            className={errors.email ? "rsv-field__input--error" : ""}
          />
          {errors.email && <span className="rsv-field__error">{errors.email}</span>}
        </label>
      </form>
    </div>
  );
}
