import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth.store";
import {
  useActiveSectors,
  useCreateCommunication,
  useEligibleMembers,
} from "../api";
import type { CommunicationKind } from "../schemas";
import {
  EmptyState,
  Header,
  PageError,
  ReadOnlyNotice,
  SaveButton,
} from "./shared";
import { isViewer } from "../utils";
import {
  changeDraft,
  isActiveSector,
  newDraft,
  stepTitle,
  toCreateInput,
  validateFirstStep,
} from "./communication-wizard-model";
import type {
  Draft,
  EligibleMember,
  UpdateDraft,
  WizardSector,
} from "./communication-wizard-model";
import {
  ContentStep,
  RecipientsStep,
  ReviewStep,
} from "./communication-wizard-steps";

export function CommunicationWizard({
  initialKind,
}: {
  initialKind?: CommunicationKind;
}) {
  return <WizardScreen wizard={useWizard(initialKind)} />;
}

function useWizard(initialKind?: CommunicationKind) {
  const user = useAuthStore((state) => state.user);
  const [step, setStep] = useState(1);
  const [validation, setValidation] = useState("");
  const [draft, setDraft] = useState(() =>
    newDraft(user?.sectorId ?? "", initialKind),
  );
  const sectors = useActiveSectors();
  const recipients = useEligibleMembers(draft.destinationSectorId);
  const create = useCreateCommunication();
  const onChange: UpdateDraft = (key, value) => {
    setValidation("");
    setDraft((current) => changeDraft(current, key, value));
  };
  return {
    user,
    draft,
    step,
    validation,
    sectors,
    recipients,
    create,
    onChange,
    onBack: () => setStep((current) => current - 1),
    onNext: () => advance(draft, step, setStep, setValidation),
    onSubmit: () =>
      create.mutate(toCreateInput(draft), { onError: () => undefined }),
  };
}

type WizardRuntime = ReturnType<typeof useWizard>;

function WizardScreen({ wizard }: { wizard: WizardRuntime }) {
  return blockedPage(wizard) ?? <WizardReady wizard={wizard} />;
}

function blockedPage(wizard: WizardRuntime): React.ReactNode | undefined {
  return (
    viewerPage(wizard.user) ??
    missingSectorPage(wizard.user) ??
    sectorStatePage(wizard.sectors) ??
    inactiveOriginPage(wizard) ??
    successPage(wizard)
  );
}

function viewerPage(user: WizardRuntime["user"]) {
  return isViewer(user?.role) ? <ReadOnlyPage /> : undefined;
}

function missingSectorPage(user: WizardRuntime["user"]) {
  return user?.role !== "ADMIN" && !user?.sectorId ? (
    <MissingSectorPage />
  ) : undefined;
}

function sectorStatePage(sectors: WizardRuntime["sectors"]) {
  if (sectors.isError)
    return (
      <PageError
        title="Não foi possível carregar os setores ativos."
        retry={() => sectors.refetch()}
      />
    );
  if (sectors.isLoading)
    return <p className="text-sm text-muted-foreground">Carregando setores…</p>;
  return !sectors.data?.length ? (
    <EmptyState>
      <p>Não há setores ativos para receber uma comunicação.</p>
    </EmptyState>
  ) : undefined;
}

function inactiveOriginPage({ user, draft, sectors }: WizardRuntime) {
  return user?.role !== "ADMIN" &&
    sectors.data &&
    !isActiveSector(sectors.data, draft.originSectorId) ? (
    <InactiveOriginPage />
  ) : undefined;
}

function successPage({ create, draft }: WizardRuntime) {
  return create.isSuccess && create.data ? (
    <SuccessPage kind={draft.kind} communicationId={create.data.id} />
  ) : undefined;
}

function WizardReady({ wizard }: { wizard: WizardRuntime }) {
  if (!wizard.sectors.data) return null;
  return (
    <WizardForm
      draft={wizard.draft}
      step={wizard.step}
      sectors={wizard.sectors.data}
      members={wizard.recipients.data ?? []}
      isAdmin={wizard.user?.role === "ADMIN"}
      error={wizard.validation}
      createError={wizard.create.isError}
      saving={wizard.create.isPending}
      onChange={wizard.onChange}
      onBack={wizard.onBack}
      onNext={wizard.onNext}
      onSubmit={wizard.onSubmit}
    />
  );
}

type WizardFormProps = {
  draft: Draft;
  step: number;
  sectors: WizardSector[];
  members: EligibleMember[];
  isAdmin: boolean;
  error: string;
  createError: boolean;
  saving: boolean;
  onChange: UpdateDraft;
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
};

function WizardForm(props: WizardFormProps) {
  return (
    <WizardLayout
      {...props}
      review={reviewData(props.draft, props.sectors, props.members)}
    />
  );
}

type ReviewData = {
  origin?: string;
  destination?: string;
  ccNames: string[];
  assigneeName?: string | null;
};

function reviewData(
  draft: Draft,
  sectors: WizardSector[],
  members: EligibleMember[],
): ReviewData {
  const origin = sectors.find(
    (sector) => sector.id === draft.originSectorId,
  )?.name;
  const destination = sectors.find(
    (sector) => sector.id === draft.destinationSectorId,
  )?.name;
  const assignee = members.find((member) => member.id === draft.assigneeId);
  const ccNames = sectors
    .filter((sector) => draft.ccSectorIds.includes(sector.id))
    .map((sector) => sector.name);
  return {
    origin,
    destination,
    ccNames,
    assigneeName: assignee?.name || assignee?.email,
  };
}

function WizardLayout({
  draft,
  step,
  sectors,
  members,
  isAdmin,
  error,
  createError,
  saving,
  onChange,
  onBack,
  onNext,
  onSubmit,
  review,
}: WizardFormProps & { review: ReviewData }) {
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <WizardHeader step={step} />
      <section className="rounded-xl border bg-card p-5">
        <WizardStep
          step={step}
          draft={draft}
          sectors={sectors}
          members={members}
          isAdmin={isAdmin}
          onChange={onChange}
          {...review}
        />
        <WizardAlerts error={error} createError={createError} />
        <WizardNavigation
          step={step}
          saving={saving}
          onBack={onBack}
          onNext={onNext}
          onSubmit={onSubmit}
        />
      </section>
    </div>
  );
}

function WizardHeader({ step }: { step: number }) {
  return (
    <>
      <Header
        eyebrow={`Nova comunicação · etapa ${step} de 3`}
        title="Nova comunicação"
        description={stepTitle(step)}
      />
      <div className="flex gap-2 text-sm">
        {[1, 2, 3].map((value) => (
          <span
            key={value}
            className={
              value === step
                ? "font-semibold text-[var(--brand-orange)]"
                : "text-muted-foreground"
            }
          >
            {value}. {stepTitle(value)}
          </span>
        ))}
      </div>
    </>
  );
}

type WizardStepProps = Pick<
  WizardFormProps,
  "step" | "draft" | "sectors" | "members" | "isAdmin" | "onChange"
> &
  ReviewData;

function WizardStep({
  step,
  draft,
  sectors,
  members,
  isAdmin,
  onChange,
  origin,
  destination,
  ccNames,
  assigneeName,
}: WizardStepProps) {
  if (step === 1)
    return (
      <ContentStep
        draft={draft}
        sectors={sectors}
        isAdmin={isAdmin}
        onChange={onChange}
      />
    );
  if (step === 2)
    return (
      <RecipientsStep
        draft={draft}
        sectors={sectors}
        members={members}
        onChange={onChange}
      />
    );
  return (
    <ReviewStep
      draft={draft}
      origin={origin}
      destination={destination}
      ccNames={ccNames}
      assigneeName={assigneeName}
    />
  );
}

function WizardAlerts({
  error,
  createError,
}: Pick<WizardFormProps, "error" | "createError">) {
  return (
    <>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {createError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          Não foi possível registrar a comunicação. Revise os dados e tente
          novamente.
        </p>
      ) : null}
    </>
  );
}

function WizardNavigation({
  step,
  saving,
  onBack,
  onNext,
  onSubmit,
}: Pick<
  WizardFormProps,
  "step" | "saving" | "onBack" | "onNext" | "onSubmit"
>) {
  return (
    <div className="mt-6 flex justify-between gap-2 border-t pt-4">
      {step > 1 ? (
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft />
          Voltar
        </Button>
      ) : (
        <span />
      )}
      {step < 3 ? (
        <Button onClick={onNext}>
          {step === 1 ? "Continuar para destinatários" : "Revisar comunicação"}
          <ArrowRight />
        </Button>
      ) : (
        <SaveButton saving={saving} onClick={onSubmit}>
          Confirmar e registrar
        </SaveButton>
      )}
    </div>
  );
}

function advance(
  draft: Draft,
  step: number,
  setStep: React.Dispatch<React.SetStateAction<number>>,
  setValidation: React.Dispatch<React.SetStateAction<string>>,
) {
  const error = step === 1 ? validateFirstStep(draft) : undefined;
  if (error) return setValidation(error);
  setStep((current) => Math.min(3, current + 1));
}

function ReadOnlyPage() {
  return (
    <div className="space-y-5">
      <Header
        eyebrow="Comunicação interna"
        title="Nova comunicação"
        description="Seu perfil permite somente consulta."
      />
      <ReadOnlyNotice />
    </div>
  );
}

function MissingSectorPage() {
  return (
    <div className="space-y-5">
      <Header
        eyebrow="Comunicação interna"
        title="Nova comunicação"
        description="Seu usuário ainda não está associado a um setor."
      />
      <EmptyState>
        <p>
          Peça a um administrador para concluir a configuração do seu setor.
        </p>
      </EmptyState>
    </div>
  );
}

function InactiveOriginPage() {
  return (
    <div className="space-y-5">
      <Header
        eyebrow="Comunicação interna"
        title="Nova comunicação"
        description="Seu setor de origem não está ativo."
      />
      <EmptyState>
        <p>
          Peça a um administrador para reativar seu setor ou atualizar sua
          vinculação antes de registrar uma comunicação.
        </p>
      </EmptyState>
    </div>
  );
}

function SuccessPage({
  kind,
  communicationId,
}: {
  kind: CommunicationKind;
  communicationId: string;
}) {
  const demand = kind === "DEMAND";
  return (
    <div className="mx-auto max-w-xl space-y-5 py-12 text-center">
      <CheckCircle2 className="mx-auto size-12 text-[var(--brand-orange)]" />
      <Header
        eyebrow="Comunicação registrada"
        title={demand ? "Demanda criada" : "Comunicado publicado"}
        description="O registro foi salvo e está disponível aos setores autorizados."
      />
      <div className="flex justify-center gap-2">
        <Button asChild variant="outline">
          <Link to="/dashboard">Visão geral</Link>
        </Button>
        <Button asChild>
          <Link
            to={
              demand
                ? "/demandas/$communicationId"
                : "/comunicados/$communicationId"
            }
            params={{ communicationId } as never}
          >
            Ver {demand ? "demanda" : "comunicado"}
          </Link>
        </Button>
      </div>
    </div>
  );
}
