import { useEffect, useMemo, useState } from "react";
import { getBookingService } from "../booking/bookingService";
import type { BookingConfirmation, CustomerInfo, Service, TimeSlot } from "../booking/types";
import { ReservationHeader } from "../components/reservation/ReservationHeader";
import { StepIndicator } from "../components/reservation/StepIndicator";
import { ServiceStep } from "../components/reservation/ServiceStep";
import { DateStep } from "../components/reservation/DateStep";
import { TimeStep } from "../components/reservation/TimeStep";
import { DetailsStep, type CustomerErrors } from "../components/reservation/DetailsStep";
import { SummaryStep } from "../components/reservation/SummaryStep";
import { ConfirmationStep } from "../components/reservation/ConfirmationStep";
import "../components/reservation/reservation.css";

const EMPTY_CUSTOMER: CustomerInfo = { firstName: "", lastName: "", phone: "", email: "" };

function validateCustomer(customer: CustomerInfo): CustomerErrors {
  const errors: CustomerErrors = {};
  if (!customer.firstName.trim()) errors.firstName = "Prénom requis.";
  if (!customer.lastName.trim()) errors.lastName = "Nom requis.";

  const phoneDigits = customer.phone.replace(/[^\d]/g, "");
  if (!customer.phone.trim()) errors.phone = "Téléphone requis.";
  else if (phoneDigits.length < 8) errors.phone = "Numéro de téléphone incomplet.";

  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    errors.email = "Adresse email invalide.";
  }
  return errors;
}

export function ReservationPage() {
  const bookingService = useMemo(() => getBookingService(), []);

  const [step, setStep] = useState(1);

  const [services, setServices] = useState<Service[]>([]);
  const [loadingServices, setLoadingServices] = useState(true);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);

  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [loadingDates, setLoadingDates] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);

  const [customer, setCustomer] = useState<CustomerInfo>(EMPTY_CUSTOMER);
  const [customerErrors, setCustomerErrors] = useState<CustomerErrors>({});

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<BookingConfirmation | null>(null);

  const selectedService = services.find((s) => s.id === selectedServiceId) ?? null;

  // Load services once.
  useEffect(() => {
    let cancelled = false;
    setLoadingServices(true);
    bookingService.getServices().then((list) => {
      if (!cancelled) {
        setServices(list);
        setLoadingServices(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [bookingService]);

  // Load available dates whenever the service changes.
  useEffect(() => {
    if (!selectedServiceId) return;
    let cancelled = false;
    setLoadingDates(true);
    setSelectedDate(null);
    setSlots([]);
    setSelectedTime(null);
    bookingService.getAvailableDates(selectedServiceId).then((dates) => {
      if (!cancelled) {
        setAvailableDates(dates);
        setLoadingDates(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [bookingService, selectedServiceId]);

  // Load slots whenever the date (or service) changes.
  useEffect(() => {
    if (!selectedServiceId || !selectedDate) return;
    let cancelled = false;
    setLoadingSlots(true);
    setSelectedTime(null);
    bookingService.getAvailableSlots(selectedDate, selectedServiceId).then((list) => {
      if (!cancelled) {
        setSlots(list);
        setLoadingSlots(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [bookingService, selectedServiceId, selectedDate]);

  function handleCustomerChange(field: keyof CustomerInfo, value: string) {
    setCustomer((c) => ({ ...c, [field]: value }));
    setCustomerErrors((errs) => ({ ...errs, [field]: undefined }));
  }

  function goNext() {
    if (step === 4) {
      const errors = validateCustomer(customer);
      setCustomerErrors(errors);
      if (Object.keys(errors).length > 0) return;
    }
    setSubmitError(null);
    setStep((s) => Math.min(s + 1, 5));
  }

  function goBack() {
    setStep((s) => Math.max(s - 1, 1));
  }

  async function handleConfirm() {
    if (!selectedService || !selectedDate || !selectedTime) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await bookingService.createBooking({
        serviceId: selectedService.id,
        date: selectedDate,
        time: selectedTime,
        customer,
      });
      setConfirmation(result);
      setStep(6);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Une erreur est survenue. Merci de réessayer.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleReset() {
    setStep(1);
    setSelectedServiceId(null);
    setSelectedDate(null);
    setSelectedTime(null);
    setCustomer(EMPTY_CUSTOMER);
    setCustomerErrors({});
    setConfirmation(null);
    setSubmitError(null);
  }

  const detailsLookComplete = customer.firstName.trim() !== "" && customer.lastName.trim() !== "" && customer.phone.trim() !== "";

  return (
    <div className="rsv-page">
      <ReservationHeader />
      {step <= 5 && <StepIndicator current={step} />}

      <main className="rsv-main">
        {step === 1 && (
          <ServiceStep
            services={services}
            loading={loadingServices}
            selectedId={selectedServiceId}
            onSelect={(id) => {
              setSelectedServiceId(id);
              setStep(2);
            }}
          />
        )}

        {step === 2 && (
          <DateStep
            availableDates={availableDates}
            loading={loadingDates}
            selectedDate={selectedDate}
            onSelect={(date) => {
              setSelectedDate(date);
              setStep(3);
            }}
          />
        )}

        {step === 3 && (
          <TimeStep
            slots={slots}
            loading={loadingSlots}
            selectedTime={selectedTime}
            onSelect={(time) => {
              setSelectedTime(time);
              setStep(4);
            }}
          />
        )}

        {step === 4 && <DetailsStep value={customer} errors={customerErrors} onChange={handleCustomerChange} />}

        {step === 5 && selectedService && selectedDate && selectedTime && (
          <SummaryStep
            service={selectedService}
            dateISO={selectedDate}
            time={selectedTime}
            customer={customer}
            onEditStep={setStep}
            submitting={submitting}
            error={submitError}
            onConfirm={handleConfirm}
          />
        )}

        {step === 6 && confirmation && <ConfirmationStep confirmation={confirmation} onReset={handleReset} />}
      </main>

      {step > 1 && step <= 4 && (
        <div className="rsv-footer-nav">
          <button type="button" className="rsv-footer-nav__back" onClick={goBack}>
            ← Retour
          </button>
          {step === 4 && (
            <button type="button" className="btn btn-solid rsv-footer-nav__continue" onClick={goNext} disabled={!detailsLookComplete}>
              Continuer
            </button>
          )}
        </div>
      )}
    </div>
  );
}
