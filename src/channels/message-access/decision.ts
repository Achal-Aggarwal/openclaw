import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveCommandAuthorizedFromAuthorizers } from "../command-gating.js";
import {
  allowedImplicitMentionKindsFromConfig,
  resolveInboundMentionDecision,
} from "../mention-gating.js";
import {
  allowlistFailureReason,
  applyIdentifierAuthenticationPolicy,
  effectiveGroupSenderAllowlist,
  redactedAllowlistDiagnostics,
} from "./allowlist.js";
import {
  DEFAULT_IDENTIFIER_AUTHENTICATION,
  meetsIdentifierAuthentication,
  minimumIdentifierAuthenticationFrom,
} from "./identifier-authentication.js";
import type {
  AccessGraphGate,
  ChannelIngressDecision,
  ChannelIngressPolicyInput,
  NormalizedIngressState,
  NormalizedIngressAllowlist,
  RedactedIngressMatch,
} from "./types.js";

function senderGate(params: {
  isGroup: boolean;
  allowed: boolean;
  reasonCode: AccessGraphGate["reasonCode"];
  policy: ChannelIngressPolicyInput["dmPolicy"] | ChannelIngressPolicyInput["groupPolicy"];
  allowlistSource: NormalizedIngressAllowlist;
}): AccessGraphGate {
  // Sender gates always include redacted allowlist facts so diagnostics can explain an
  // allow/block result without exposing raw sender ids.
  return {
    id: params.isGroup ? "sender:group" : "sender:dm",
    phase: "sender",
    kind: params.isGroup ? "groupSender" : "dmSender",
    effect: params.allowed ? "allow" : "block-dispatch",
    allowed: params.allowed,
    reasonCode: params.reasonCode,
    match: params.allowlistSource.match,
    sender: { policy: params.policy },
    allowlist: redactedAllowlistDiagnostics(params.allowlistSource, params.reasonCode),
    ...(params.allowlistSource.authentication
      ? {
          identifierAuthentication: {
            evaluated: params.allowlistSource.authentication.evaluated,
            affectedMatch: params.allowlistSource.authentication.affectedMatch,
          },
        }
      : {}),
  };
}

function senderGateForDirect(params: {
  state: NormalizedIngressState;
  policy: ChannelIngressPolicyInput;
}): AccessGraphGate {
  const dm = applyIdentifierAuthenticationPolicy(params.state.allowlists.dm, params.policy);
  const pairingStore = applyIdentifierAuthenticationPolicy(
    params.state.allowlists.pairingStore,
    params.policy,
  );
  const decide = (
    allowed: boolean,
    reasonCode: AccessGraphGate["reasonCode"],
    allowlistSource = dm,
  ) =>
    senderGate({
      isGroup: false,
      policy: params.policy.dmPolicy,
      allowlistSource,
      allowed,
      reasonCode,
    });
  if (params.policy.dmPolicy === "disabled") {
    return decide(false, "dm_policy_disabled");
  }
  if (params.policy.dmPolicy === "open") {
    // Open DM policy still requires either wildcard or an explicit normalized entry so
    // configured allowlists keep their narrowing effect.
    if (dm.hasWildcard) {
      return decide(true, "dm_policy_open");
    }
    if (dm.match.matched) {
      return decide(true, "dm_policy_allowlisted");
    }
    return decide(false, "dm_policy_not_allowlisted");
  }
  if (dm.match.matched) {
    return decide(true, "dm_policy_allowlisted");
  }
  if (params.policy.dmPolicy === "pairing" && pairingStore.match.matched) {
    // Pairing-store matches are only valid for pairing policy, never for open/allowlist modes.
    return decide(true, "dm_policy_allowlisted", pairingStore);
  }
  if (params.policy.dmPolicy === "pairing" && params.state.event.mayPair) {
    return decide(false, "dm_policy_pairing_required");
  }
  const reasonCode =
    params.policy.dmPolicy === "pairing"
      ? "event_pairing_not_allowed"
      : (allowlistFailureReason(dm) ?? "dm_policy_not_allowlisted");
  return decide(false, reasonCode);
}

function senderGateForGroup(params: {
  state: NormalizedIngressState;
  policy: ChannelIngressPolicyInput;
}): AccessGraphGate {
  const group = effectiveGroupSenderAllowlist(params);
  const decide = (allowed: boolean, reasonCode: AccessGraphGate["reasonCode"]) =>
    senderGate({
      isGroup: true,
      policy: params.policy.groupPolicy,
      allowlistSource: group,
      allowed,
      reasonCode,
    });
  if (params.policy.groupPolicy === "disabled") {
    return decide(false, "group_policy_disabled");
  }
  if (params.policy.groupPolicy === "open") {
    return decide(true, "group_policy_open");
  }
  if (!group.hasConfiguredEntries) {
    return decide(false, "group_policy_empty_allowlist");
  }
  if (group.match.matched) {
    return decide(true, "group_policy_allowed");
  }
  return decide(false, allowlistFailureReason(group) ?? "group_policy_not_allowlisted");
}

function applyEventAuthModeToSenderGate(params: {
  state: NormalizedIngressState;
  senderGate: AccessGraphGate;
}): AccessGraphGate {
  if (params.state.event.authMode === "inbound" || params.senderGate.allowed) {
    return params.senderGate;
  }
  // Non-inbound events can be authorized by command/origin/route gates, so a failed sender
  // gate becomes an ignored diagnostic instead of a dispatch block.
  const reasonCode = "sender_not_required";
  return {
    ...params.senderGate,
    effect: "ignore",
    allowed: true,
    reasonCode,
    allowlist: params.senderGate.allowlist
      ? { ...params.senderGate.allowlist, reasonCode }
      : undefined,
  };
}

function routeGates(state: NormalizedIngressState): AccessGraphGate[] {
  // Route gates run first because a matched route can block dispatch before sender,
  // command, or mention policy needs to evaluate.
  return state.routeFacts.map((route) => ({
    id: route.id,
    phase: "route",
    kind: route.kind,
    effect: route.effect,
    allowed: route.effect !== "block-dispatch",
    reasonCode: route.effect === "block-dispatch" ? "route_blocked" : "allowed",
    match: route.match,
  }));
}

function routeSenderEmptyGate(state: NormalizedIngressState): AccessGraphGate | null {
  // deny-when-empty route sender policy means the route matched but has no sender list to
  // authorize against, so it becomes an explicit route block.
  const route = state.routeFacts.find(
    (fact) =>
      fact.senderPolicy === "deny-when-empty" &&
      fact.gate === "matched" &&
      fact.senderAllowlist?.hasConfiguredEntries !== true,
  );
  if (!route) {
    return null;
  }
  const reasonCode = "route_sender_empty";
  return {
    id: `${route.id}:sender`,
    phase: "route",
    kind: "routeSender",
    effect: "block-dispatch",
    allowed: false,
    reasonCode,
    match: route.match,
    allowlist: route.senderAllowlist
      ? redactedAllowlistDiagnostics(route.senderAllowlist, reasonCode)
      : undefined,
  };
}

function commandGate(params: {
  state: NormalizedIngressState;
  policy: ChannelIngressPolicyInput;
}): AccessGraphGate {
  const command = params.policy.command;
  if (!command) {
    return {
      id: "command",
      phase: "command",
      kind: "command",
      effect: "allow",
      allowed: true,
      reasonCode: "command_authorized",
    };
  }
  const useAccessGroups = command.useAccessGroups ?? true;
  // Command authorization combines owner and group allowlists after authentication policy so
  // command control cannot be granted by identifiers the current policy rejects.
  const owner = applyIdentifierAuthenticationPolicy(
    params.state.allowlists.commandOwner,
    params.policy,
  );
  const group = applyIdentifierAuthenticationPolicy(
    params.state.allowlists.commandGroup,
    params.policy,
  );
  const authorized = resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups,
    modeWhenAccessGroupsOff: command.modeWhenAccessGroupsOff,
    authorizers: [
      { configured: owner.hasConfiguredEntries, allowed: owner.match.matched },
      { configured: group.hasConfiguredEntries, allowed: group.match.matched },
    ],
  });
  const shouldBlock = command.allowTextCommands && command.hasControlCommand && !authorized;
  return {
    id: "command",
    phase: "command",
    kind: "command",
    effect: shouldBlock ? "block-command" : "allow",
    allowed: authorized,
    reasonCode: shouldBlock ? "control_command_unauthorized" : "command_authorized",
    match: mergeCommandMatch(owner.match, group.match),
    identifierAuthentication: {
      evaluated: Boolean(owner.authentication?.evaluated || group.authentication?.evaluated),
      affectedMatch: Boolean(
        owner.authentication?.affectedMatch || group.authentication?.affectedMatch,
      ),
    },
    command: {
      useAccessGroups,
      allowTextCommands: command.allowTextCommands,
      modeWhenAccessGroupsOff: command.modeWhenAccessGroupsOff,
      shouldBlockControlCommand: shouldBlock,
    },
  };
}

function mergeCommandMatch(
  owner: RedactedIngressMatch,
  group: RedactedIngressMatch,
): RedactedIngressMatch {
  const matchedEntryIds = uniqueStrings([...owner.matchedEntryIds, ...group.matchedEntryIds]);
  return {
    matched: owner.matched || group.matched || matchedEntryIds.length > 0,
    matchedEntryIds,
  };
}

function eventGate(params: {
  state: NormalizedIngressState;
  policy: ChannelIngressPolicyInput;
  senderGate: AccessGraphGate;
  commandGate: AccessGraphGate;
}): AccessGraphGate {
  const authMode = params.state.event.authMode;
  const event = params.state.event;
  const eventResult = (
    allowed: boolean,
    reasonCode: AccessGraphGate["reasonCode"],
  ): AccessGraphGate => ({
    id: "event",
    phase: "event",
    kind: "event",
    effect: allowed ? "allow" : "block-dispatch",
    allowed,
    reasonCode,
    event,
  });
  if (authMode === "none" || authMode === "route-only") {
    return eventResult(true, "event_authorized");
  }
  if (authMode === "origin-subject") {
    // Origin-subject mode is used for callbacks tied to a prior message/user identity.
    if (!params.state.event.hasOriginSubject) {
      return eventResult(false, "origin_subject_missing");
    }
    const matched =
      params.state.event.originSubjectMatched &&
      meetsIdentifierAuthentication(
        params.state.event.originSubjectAuthentication ?? DEFAULT_IDENTIFIER_AUTHENTICATION,
        minimumIdentifierAuthenticationFrom(params.policy),
      );
    return {
      ...eventResult(matched, matched ? "event_authorized" : "origin_subject_not_matched"),
      identifierAuthentication: {
        evaluated:
          params.policy.minIdentifierAuthentication !== undefined ||
          params.policy.mutableIdentifierMatching !== undefined ||
          params.state.event.originSubjectAuthentication !== undefined,
        affectedMatch: params.state.event.originSubjectMatched && !matched,
      },
    };
  }
  // Command-auth events, such as button or slash command callbacks, inherit the command gate
  // result instead of re-checking the sender allowlist.
  const gate = authMode === "command" ? params.commandGate : params.senderGate;
  return eventResult(gate.allowed, gate.allowed ? "event_authorized" : "event_unauthorized");
}

function activationGate(params: {
  state: NormalizedIngressState;
  policy: ChannelIngressPolicyInput;
  commandGate: AccessGraphGate;
}): AccessGraphGate {
  const activation = params.policy.activation;
  const mentionFacts = params.state.mentionFacts;
  const allowedImplicitMentionKinds =
    activation?.allowedImplicitMentionKinds ??
    (activation?.implicitMentions
      ? allowedImplicitMentionKindsFromConfig(activation.implicitMentions)
      : undefined);
  const activationResult = (input: {
    shouldSkip: boolean;
    effectiveWasMentioned?: boolean;
    shouldBypassMention?: boolean;
  }): AccessGraphGate => ({
    id: "activation",
    phase: "activation",
    kind: "mention",
    effect: input.shouldSkip ? "skip" : "allow",
    allowed: !input.shouldSkip,
    reasonCode: input.shouldSkip ? "activation_skipped" : "activation_allowed",
    activation: {
      hasMentionFacts: mentionFacts != null,
      requireMention: activation?.requireMention ?? false,
      allowTextCommands: activation?.allowTextCommands ?? false,
      ...(allowedImplicitMentionKinds !== undefined ? { allowedImplicitMentionKinds } : {}),
      ...(activation?.order ? { order: activation.order } : {}),
      shouldSkip: input.shouldSkip,
      ...(mentionFacts?.canDetectMention !== undefined
        ? { canDetectMention: mentionFacts.canDetectMention }
        : {}),
      ...(mentionFacts?.wasMentioned !== undefined
        ? { wasMentioned: mentionFacts.wasMentioned }
        : {}),
      ...(mentionFacts?.hasAnyMention !== undefined
        ? { hasAnyMention: mentionFacts.hasAnyMention }
        : {}),
      ...(mentionFacts?.implicitMentionKinds !== undefined
        ? { implicitMentionKinds: mentionFacts.implicitMentionKinds }
        : {}),
      ...(input.effectiveWasMentioned !== undefined
        ? { effectiveWasMentioned: input.effectiveWasMentioned }
        : {}),
      ...(input.shouldBypassMention !== undefined
        ? { shouldBypassMention: input.shouldBypassMention }
        : {}),
    },
  });
  if (!activation || !mentionFacts) {
    // Without activation policy or mention facts, sender/event authorization is enough.
    return activationResult({
      shouldSkip: false,
      effectiveWasMentioned:
        mentionFacts &&
        (mentionFacts.wasMentioned || Boolean(mentionFacts.implicitMentionKinds?.length)),
    });
  }
  const result = resolveInboundMentionDecision({
    facts: mentionFacts,
    policy: {
      isGroup: params.state.conversationKind !== "direct",
      requireMention: activation.requireMention,
      allowedImplicitMentionKinds,
      allowTextCommands: activation.allowTextCommands,
      hasControlCommand: params.policy.command?.hasControlCommand ?? false,
      commandAuthorized: params.commandGate.allowed,
    },
  });
  return activationResult({
    shouldSkip: result.shouldSkip,
    effectiveWasMentioned: result.effectiveWasMentioned,
    shouldBypassMention: result.shouldBypassMention,
  });
}

export function decideChannelIngress(
  state: NormalizedIngressState,
  policy: ChannelIngressPolicyInput,
): ChannelIngressDecision {
  const gates: AccessGraphGate[] = routeGates(state);
  const decide = (
    gate: AccessGraphGate,
    admission: ChannelIngressDecision["admission"],
    decision: ChannelIngressDecision["decision"],
  ): ChannelIngressDecision => ({
    admission,
    decision,
    decisiveGateId: gate.id,
    reasonCode: gate.reasonCode,
    graph: { gates },
  });
  const emptyRouteSenderGate = routeSenderEmptyGate(state);
  if (emptyRouteSenderGate) {
    gates.push(emptyRouteSenderGate);
  }
  const routeBlock = gates.find((entry) => entry.effect === "block-dispatch");
  if (routeBlock) {
    return decide(routeBlock, "drop", "block");
  }

  // Some channels want mention gating before sender checks so unmentioned room chatter can
  // short-circuit without exposing sender allowlist diagnostics.
  const activationBeforeSender =
    policy.activation?.order === "before-sender" && !policy.activation.allowTextCommands
      ? activationGate({
          state,
          policy,
          commandGate: commandGate({ state, policy: { ...policy, command: undefined } }),
        })
      : null;
  if (activationBeforeSender) {
    gates.push(activationBeforeSender);
    if (activationBeforeSender.effect === "skip") {
      return decide(activationBeforeSender, "skip", "allow");
    }
  }

  const sender =
    state.conversationKind === "direct"
      ? senderGateForDirect({ state, policy })
      : senderGateForGroup({ state, policy });
  // Event auth mode can relax or tighten how sender gates affect non-message events.
  const eventModeSender = applyEventAuthModeToSenderGate({ state, senderGate: sender });
  gates.push(eventModeSender);
  if (!eventModeSender.allowed) {
    const admission =
      eventModeSender.reasonCode === "dm_policy_pairing_required" ? "pairing-required" : "drop";
    const decision =
      eventModeSender.reasonCode === "dm_policy_pairing_required" ? "pairing" : "block";
    return decide(eventModeSender, admission, decision);
  }

  const command = commandGate({ state, policy });
  gates.push(command);
  if (command.effect === "block-command") {
    return decide(command, "drop", "block");
  }

  const event = eventGate({ state, policy, senderGate: eventModeSender, commandGate: command });
  gates.push(event);
  if (!event.allowed) {
    return decide(event, "drop", "block");
  }

  const activation =
    activationBeforeSender ?? activationGate({ state, policy, commandGate: command });
  if (!activationBeforeSender) {
    gates.push(activation);
  }
  if (activation.effect === "skip") {
    return decide(activation, "skip", "allow");
  }
  return decide(activation, "dispatch", "allow");
}
