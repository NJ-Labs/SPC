import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, Send, Sparkles, X, RefreshCcw, Hash, Clock, Copy, Download, Edit3, Check, FileSpreadsheet } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { useLanguage } from '../../context/LanguageContext';
import {
  buildAgentAutopilotPrompt,
  buildAssistantSystemPrompt,
  buildDatasetUpdatePrompt,
  buildInitialUserPrompt,
  summarizeDatasetForAi,
} from '../../utils/aiHelpers';
import type { AgentConfigEvidence, AiChatAttachment, AiChatMessage, AiWorksheetOption } from '../../types/AiTypes';
import { chartMeta } from '../../types/chartMeta';
import {
  ChainOfThought,
  ChainOfThoughtHeader,
  ChainOfThoughtContent,
  ChainOfThoughtStep,
} from '../ai-elements/chain-of-thought';
import {
  buildAgentTurnRequest,
  scopeDatasetForAi,
  type AgentControlPatch,
  type AgentControlsSnapshotInput,
  type AgentTurnResponse,
} from '../../utils/aiTools';
import { resolveAiRuntimeConfig } from '../../utils/runtimeConfig';
import { AgentConfigEvidenceView } from './AgentConfigEvidence';
import { AssistantMessageContent } from './AssistantMessageContent';
import {
  buildAgentConfigState,
  buildRequestHistory,
  EVIDENCE_OUTCOME_KEYS,
  resolveAgentControlPatch,
  type AgentRequestContext,
} from './agentConfig';
import { ASSISTANT_HTML_ARTIFACT_GUIDE, ASSISTANT_HTML_GUIDE_MARKER } from './assistantHtml';

const extractAiErrorMessage = async (response: Response, t: (key: string) => string): Promise<string> => {
  const code = response.headers.get('X-SPC-Error-Code');
  if (code === 'upstream_api_key_invalid') return t('ai.invalidApiKey');
  if (code === 'upstream_permission_denied') return t('ai.keyPermissionDenied');
  const fallback = `AI service request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ''}).`;

  try {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const payload = await response.json();
      const message =
        payload?.error?.message
        ?? payload?.error
        ?? payload?.detail
        ?? payload?.message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    } else {
      const bodyText = (await response.text()).trim();
      if (bodyText) {
        return bodyText;
      }
    }
  } catch {
    // ignore parse errors and use fallback
  }

  return fallback;
};

interface AiAssistantPanelProps {
  onClose: () => void;
}

const COPY_FEEDBACK_MS = 1600;
const STICK_TO_BOTTOM_PX = 48;
let messageCounter = 0;
const nextMessageId = (prefix: string): string => {
  messageCounter += 1;
  return `${prefix}-${Date.now()}-${messageCounter}`;
};

const AiAssistantPanel: React.FC<AiAssistantPanelProps> = ({ onClose }) => {
  const {
    rawData,
    processedData,
    selectedColumns,
    xAxisColumn,
    denominatorColumn,
    sampleSize,
    selectedChartType,
    chartOptions,
    selectedDataRange,
    setSelectedChartType,
    setChartOptions,
    setSelectedColumns,
    setXAxisColumn,
    setDenominatorColumn,
    setSampleSize,
    setActiveSheetIndex,
  } = useAppContext();
  
  const { language, t } = useLanguage();

  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [agentModeEnabled, setAgentModeEnabled] = useState(false);
  const [agentFeedback, setAgentFeedback] = useState<string | null>(null);
  const [selectedAiSheetIndex, setSelectedAiSheetIndex] = useState<number | null>(null);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const conversationRef = useRef<AiChatMessage[]>([]);
  const lastSummaryRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sheetSelectionContextRef = useRef<string | null>(null);
  const agentAutopilotContextRef = useRef<string | null>(null);
  const suppressNextAgentAutopilotRef = useRef(false);
  const requestInFlightRef = useRef(false);
  const initializationStartedRef = useRef(false);

  // Responses arrive long after the render that started the request, so settings and the dataset
  // are read from this ref at apply time rather than from a stale closure.
  const currentConfig = useMemo(
    () => buildAgentConfigState({
      chartType: selectedChartType,
      chartOptions,
      selectedColumns,
      xAxisColumn,
      denominatorColumn,
      sampleSize,
    }),
    [chartOptions, denominatorColumn, sampleSize, selectedChartType, selectedColumns, xAxisColumn],
  );
  const datasetFingerprint = useMemo(
    () => (rawData
      ? [
        rawData.fileName,
        rawData.activeSheetIndex ?? 0,
        rawData.data.length,
        rawData.headers.join('\u0001'),
        // The charted range changes which rows the columns mean, so it is part of "the same data".
        selectedDataRange ? JSON.stringify(selectedDataRange) : 'all-rows',
      ].join('::')
      : 'no-dataset'),
    [rawData, selectedDataRange],
  );
  const dataRef = rawData?.data ?? null;
  const liveRef = useRef({
    config: currentConfig,
    chartOptions,
    headers: rawData?.headers ?? [],
    fingerprint: datasetFingerprint,
    dataRef,
  });
  liveRef.current = {
    config: currentConfig,
    chartOptions,
    headers: rawData?.headers ?? [],
    fingerprint: datasetFingerprint,
    dataRef,
  };

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const worksheetOptions = useMemo<AiWorksheetOption[]>(() => {
    if (!rawData?.sheets?.length) {
      return [];
    }

    return rawData.sheets.map((sheet, index) => ({
      index,
      name: sheet.name,
      rows: sheet.data.length,
      columns: sheet.headers.length,
    }));
  }, [rawData]);

  const requiresWorksheetSelection = Boolean(rawData?.sheets && rawData.sheets.length > 1 && selectedAiSheetIndex === null);

  const systemPrompt = useMemo(() => {
    const base = buildAssistantSystemPrompt(language, agentModeEnabled);
    // Idempotent: skipped when the shared prompt builder already carries the guide.
    return base.includes(ASSISTANT_HTML_GUIDE_MARKER) ? base : `${base}\n\n${ASSISTANT_HTML_ARTIFACT_GUIDE}`;
  }, [agentModeEnabled, language]);
  const friendlyChartName = useMemo(
    () => chartMeta[selectedChartType]?.name ?? selectedChartType,
    [selectedChartType],
  );
  const datasetSummary = useMemo(
    () =>
      summarizeDatasetForAi(
        scopeDatasetForAi(rawData, selectedDataRange),
        processedData,
        selectedColumns,
        xAxisColumn,
        denominatorColumn,
        sampleSize,
        { chartType: selectedChartType, ruleSet: chartOptions.ruleSet },
      ),
    [chartOptions.ruleSet, denominatorColumn, processedData, rawData, sampleSize, selectedChartType, selectedColumns, selectedDataRange, xAxisColumn],
  );

  const appendAssistantMessage = useCallback((content: string) => {
    const assistantMessage: AiChatMessage = {
      id: nextMessageId('assistant'),
      role: 'assistant',
      content,
      createdAt: Date.now(),
      autoGenerated: true,
    };
    const updated = [...conversationRef.current, assistantMessage];
    conversationRef.current = updated;
    setMessages(updated);
    return assistantMessage;
  }, []);

  const tokenCountFor = (content: string) => {
    const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;
    return Math.max(1, Math.ceil(wordCount * 1.35));
  };

  const captureRequestContext = useCallback((): AgentRequestContext => ({
    config: liveRef.current.config,
    fingerprint: liveRef.current.fingerprint,
    dataRef: liveRef.current.dataRef,
  }), []);

  const applyAgentControlPatch = useCallback((
    patch: AgentControlPatch | null | undefined,
    request: AgentRequestContext,
  ): AgentConfigEvidence => {
    const live = liveRef.current;
    const { next, updates, evidence } = resolveAgentControlPatch(
      patch as Record<string, unknown> | null | undefined,
      live.config,
      {
        headers: live.headers,
        requestSnapshot: request.config,
        staleDataset: live.fingerprint !== request.fingerprint || live.dataRef !== request.dataRef,
      },
    );

    if (updates.chartType !== undefined) setSelectedChartType(updates.chartType);
    if (updates.selectedColumns !== undefined) setSelectedColumns(updates.selectedColumns);
    if ('xAxisColumn' in updates) setXAxisColumn(updates.xAxisColumn ?? null);
    if ('denominatorColumn' in updates) setDenominatorColumn(updates.denominatorColumn ?? null);
    if (updates.sampleSize !== undefined) setSampleSize(updates.sampleSize);
    const nextChartOptions = updates.chartOptions ? { ...live.chartOptions, ...updates.chartOptions } : live.chartOptions;
    if (updates.chartOptions) setChartOptions(nextChartOptions);

    // Two turns can resolve before React re-renders, so later ones must see these writes.
    liveRef.current = { ...live, config: next, chartOptions: nextChartOptions };

    const counts = [
      evidence.counts.applied > 0 ? `${t('ai.evidence.applied')} ${evidence.counts.applied}` : null,
      evidence.counts.unchanged > 0 ? `${t('ai.evidence.unchanged')} ${evidence.counts.unchanged}` : null,
      evidence.counts.rejected > 0 ? `${t('ai.evidence.rejected')} ${evidence.counts.rejected}` : null,
    ].filter(Boolean).join(' · ');
    setAgentFeedback([t(EVIDENCE_OUTCOME_KEYS[evidence.outcome]), counts].filter(Boolean).join(' — '));

    if (evidence.counts.applied > 0) {
      suppressNextAgentAutopilotRef.current = true;
    }
    return evidence;
  }, [setChartOptions, setDenominatorColumn, setSampleSize, setSelectedChartType, setSelectedColumns, setXAxisColumn, t]);

  const runAgentModeTurn = useCallback(async (
    conversationForRequest: AiChatMessage[],
    endpoint: string,
    apiKey: string,
    model: string,
    shouldSendTemperature: boolean,
  ): Promise<AgentTurnResponse> => {
    const agentState: AgentControlsSnapshotInput = {
      rawData,
      selectedChartType,
      chartOptions,
      selectedColumns,
      xAxisColumn,
      denominatorColumn,
      sampleSize,
      language,
      agentModeEnabled: true,
      selectedAiSheetIndex,
      selectedDataRange,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildAgentTurnRequest(agentState, conversationForRequest, {
        model,
        systemPrompt,
        datasetSummary,
        processedData,
        ...(shouldSendTemperature ? { temperature: 0.2 } : {}),
      })),
    });

    if (!response.ok) {
      throw new Error(await extractAiErrorMessage(response, t));
    }

    return await response.json() as AgentTurnResponse;
  }, [chartOptions, datasetSummary, denominatorColumn, language, processedData, rawData, sampleSize, selectedAiSheetIndex, selectedChartType, selectedColumns, selectedDataRange, systemPrompt, t, xAxisColumn]);

  const handleCopy = async (messageId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(messageId);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedId(null), COPY_FEEDBACK_MS);
    } catch {
      setCopiedId(null);
    }
  };

  const handleDownload = (content: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'assistant-response.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const appendWorksheetSelectionMessage = useCallback(() => {
    if (!rawData?.sheets || rawData.sheets.length <= 1) {
      return;
    }

    const lastMessage = conversationRef.current[conversationRef.current.length - 1];
    if (lastMessage?.role === 'assistant' && lastMessage.worksheetOptions?.length) {
      return;
    }

    const sheetMessage: AiChatMessage = {
      id: `assistant-sheets-${Date.now()}`,
      role: 'assistant',
      content: t('ai.selectWorksheetPrompt'),
      createdAt: Date.now(),
      autoGenerated: true,
      worksheetOptions,
    };

    const updated = [...conversationRef.current, sheetMessage];
    conversationRef.current = updated;
    setMessages(updated);
  }, [rawData?.sheets, t, worksheetOptions]);

  const handleWorksheetSelect = useCallback((sheetIndex: number) => {
    if (!rawData?.sheets || sheetIndex < 0 || sheetIndex >= rawData.sheets.length) {
      return;
    }

    setActiveSheetIndex(sheetIndex);
    setSelectedAiSheetIndex(sheetIndex);
    setAgentFeedback(null);
    appendAssistantMessage(
      `${t('ai.worksheetSelectedPrefix')}: ${rawData.sheets[sheetIndex].name}`,
    );
  }, [appendAssistantMessage, rawData?.sheets, setActiveSheetIndex, t]);

  const sendMessage = useCallback(
    async (
      content: string,
      options?: {
        skipInputReset?: boolean;
        autoGenerated?: boolean;
        attachment?: AiChatAttachment;
        hideUserMessage?: boolean;
      },
    ) => {
      if (requiresWorksheetSelection) {
        setError(null);
        appendWorksheetSelectionMessage();
        return;
      }

      const trimmed = content.trim();
      if (!trimmed) {
        return;
      }

      if (requestInFlightRef.current) {
        return;
      }

      requestInFlightRef.current = true;
      const requestAgentMode = agentModeEnabled;

      const userMessage: AiChatMessage = {
        id: nextMessageId('user'),
        role: 'user',
        content: trimmed,
        createdAt: Date.now(),
        autoGenerated: options?.autoGenerated,
        hidden: options?.hideUserMessage,
        agentModeRequest: requestAgentMode,
        attachment: options?.attachment,
      };

      const conversationForRequest = [...conversationRef.current, userMessage];
      // Earlier agent turns carry what the app verified, so stale prose is not mistaken for state.
      const historyForRequest = buildRequestHistory(conversationForRequest, liveRef.current.config);
      const conversationWithUser = options?.hideUserMessage
        ? conversationRef.current
        : conversationForRequest;
      conversationRef.current = conversationWithUser;
      setMessages(conversationWithUser);
      if (!options?.skipInputReset) {
        setInputValue('');
      }

      setIsLoading(true);
      setError(null);

      const { apiUrl, apiKey, model } = resolveAiRuntimeConfig();

      if (!apiUrl || !apiKey || !model) {
        const missingGatewayModel = apiUrl === '/' && Boolean(apiKey) && !model;
        setError(t(missingGatewayModel ? 'ai.gatewayModelMissing' : 'ai.notConfigured'));
        appendAssistantMessage(t(missingGatewayModel ? 'ai.gatewayModelMissing' : 'ai.configError'));
        setIsLoading(false);
        requestInFlightRef.current = false;
        return;
      }

      const trimmedUrl = apiUrl.replace(/\/$/, '');
      const endpoint = /\/v1\/chat\/completions$/i.test(trimmedUrl)
        ? trimmedUrl
        : `${trimmedUrl}/v1/chat/completions`;
      const agentEndpoint = /\/v1\/chat\/completions$/i.test(trimmedUrl)
        ? trimmedUrl.replace(/\/v1\/chat\/completions$/i, '/v1/agent/turn')
        : `${trimmedUrl}/v1/agent/turn`;
      const normalizedModel = model.trim().toLowerCase();
      const shouldSendTemperature = !normalizedModel.startsWith('gpt');

      try {
        const startTime = Date.now();
        if (requestAgentMode) {
          const requestContext = captureRequestContext();
          const result = await runAgentModeTurn(historyForRequest, agentEndpoint, apiKey, model, shouldSendTemperature);
          const evidence = applyAgentControlPatch(result.controlPatch, requestContext);
          const assistantMessage: AiChatMessage = {
            id: nextMessageId('assistant'),
            role: 'assistant',
            content: result.content,
            createdAt: Date.now(),
            tokenCount: tokenCountFor(result.content),
            responseTimeMs: Math.max(0, Date.now() - startTime),
            parentUserId: userMessage.id,
            ...(result.reasoning ? { reasoning: result.reasoning } : {}),
            agentModeRequest: true,
            configEvidence: evidence,
          };
          const conversationWithAssistant = [...conversationWithUser, assistantMessage];
          conversationRef.current = conversationWithAssistant;
          setMessages(conversationWithAssistant);
          return;
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              ...historyForRequest.map((message) => ({
                role: message.role,
                content: message.content,
              })),
            ],
            ...(shouldSendTemperature ? { temperature: 0.2 } : {}),
            stream: true,
          }),
        });

        // If the server does not support streaming, fall back to JSON body
        const contentType = response.headers.get('content-type') || '';
        const supportsStream = response.ok && contentType.includes('text/event-stream');

        if (supportsStream && response.body) {
          const assistantMessage: AiChatMessage = {
            id: nextMessageId('assistant'),
            role: 'assistant',
            content: '',
            createdAt: Date.now(),
            parentUserId: userMessage.id,
            agentModeRequest: requestAgentMode,
          };
          const withAssistant = [...conversationWithUser, assistantMessage];
          conversationRef.current = withAssistant;
          setMessages(withAssistant);
          setStreamingMessageId(assistantMessage.id);

          const reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';
          let doneStreaming = false;

          const applyDelta = (delta: string) => {
            if (!delta) return;
            assistantMessage.content += delta;
            // Trigger React update with the mutated message
            setMessages([...conversationRef.current]);
          };

          const applyReasoningDelta = (delta: string) => {
            if (!delta) return;
            assistantMessage.reasoning = (assistantMessage.reasoning ?? '') + delta;
            setMessages([...conversationRef.current]);
          };

          const processEvent = (rawEvent: string) => {
            const lines = rawEvent.split('\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue; // comment/keep-alive
              if (!trimmed.startsWith('data:')) continue;
              const data = trimmed.slice(5).trim();
              if (data === '[DONE]') {
                doneStreaming = true;
                return;
              }
              try {
                const parsed = JSON.parse(data);
                // OpenAI Chat Completions delta shape
                const piece: string | undefined = parsed?.choices?.[0]?.delta?.content;
                if (typeof piece === 'string') {
                  applyDelta(piece);
                }
                // vLLM reasoning_content (Gemma 4 thinking mode, DeepSeek R1, etc.)
                const reasoningPiece: string | undefined = parsed?.choices?.[0]?.delta?.reasoning_content;
                if (typeof reasoningPiece === 'string') {
                  applyReasoningDelta(reasoningPiece);
                }
              } catch {
                // Non-JSON data line; ignore
              }
            }
          };

          // Read the stream
          while (!doneStreaming) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
              const eventChunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              processEvent(eventChunk);
              if (doneStreaming) break;
              boundary = buffer.indexOf('\n\n');
            }
          }

          // If any remainder exists, attempt to process it
          if (buffer && !doneStreaming) {
            processEvent(buffer);
          }

          // Finalize conversation state
          assistantMessage.tokenCount = tokenCountFor(assistantMessage.content);
          assistantMessage.responseTimeMs = Math.max(0, Date.now() - startTime);
          conversationRef.current = [...conversationRef.current];
          setMessages([...conversationRef.current]);
        } else {
          if (!response.ok) {
            throw new Error(await extractAiErrorMessage(response, t));
          }
          const payload = await response.json();
          const assistantText: string | undefined = payload?.choices?.[0]?.message?.content?.trim();
          if (!assistantText) {
            throw new Error('The AI service returned an empty response.');
          }
          const reasoningText: string | undefined = payload?.choices?.[0]?.message?.reasoning_content?.trim();
          const assistantMessage: AiChatMessage = {
            id: nextMessageId('assistant'),
            role: 'assistant',
            content: assistantText,
            createdAt: Date.now(),
            tokenCount: tokenCountFor(assistantText),
            responseTimeMs: 0,
            parentUserId: userMessage.id,
            ...(reasoningText ? { reasoning: reasoningText } : {}),
            agentModeRequest: requestAgentMode,
          };
          assistantMessage.responseTimeMs = Math.max(0, Date.now() - startTime);
          const conversationWithAssistant = [...conversationWithUser, assistantMessage];
          conversationRef.current = conversationWithAssistant;
          setMessages(conversationWithAssistant);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unexpected error while contacting the AI service.';
        setError(message);
        appendAssistantMessage(`${t('ai.serviceError')}${message}`);
      } finally {
        setIsLoading(false);
        setStreamingMessageId(null);
        requestInFlightRef.current = false;
      }
    },
    [agentModeEnabled, appendAssistantMessage, appendWorksheetSelectionMessage, applyAgentControlPatch, captureRequestContext, requiresWorksheetSelection, runAgentModeTurn, systemPrompt, t],
  );

  const datasetAttachment = useMemo<AiChatAttachment | undefined>(() => {
    if (!rawData) return undefined;
    return {
      name: rawData.fileName || t('ai.uploadedDataset'),
      type: rawData.fileType || undefined,
      rows: rawData.data.length,
      columns: rawData.headers.length,
    };
  }, [rawData, t]);

  const regenerateAssistantForUserIndex = useCallback(
    async (userIndex: number, assistantIndex: number) => {
      if (requestInFlightRef.current) {
        return;
      }

      requestInFlightRef.current = true;

      const { apiUrl, apiKey, model } = resolveAiRuntimeConfig();
      if (!apiUrl || !apiKey || !model) {
        setError(t(apiUrl === '/' && apiKey && !model ? 'ai.gatewayModelMissing' : 'ai.notConfigured'));
        requestInFlightRef.current = false;
        return;
      }
      const trimmedUrl = apiUrl.replace(/\/$/, '');
      const endpoint = /\/v1\/chat\/completions$/i.test(trimmedUrl)
        ? trimmedUrl
        : `${trimmedUrl}/v1/chat/completions`;
      const agentEndpoint = /\/v1\/chat\/completions$/i.test(trimmedUrl)
        ? trimmedUrl.replace(/\/v1\/chat\/completions$/i, '/v1/agent/turn')
        : `${trimmedUrl}/v1/agent/turn`;
      const normalizedModel = model.trim().toLowerCase();
      const shouldSendTemperature = !normalizedModel.startsWith('gpt');

      const convo = conversationRef.current;
      const targetAssistant = convo[assistantIndex];
      if (!targetAssistant || targetAssistant.role !== 'assistant') {
        requestInFlightRef.current = false;
        return;
      }

      setIsLoading(true);
      setStreamingMessageId(targetAssistant.id);
      setError(null);
      const startTime = Date.now();

      try {
        // Build messages up to and including the parent user message
        const subset = buildRequestHistory(convo.slice(0, userIndex + 1), liveRef.current.config);
        if (targetAssistant.agentModeRequest) {
          const requestContext = captureRequestContext();
          const result = await runAgentModeTurn(subset, agentEndpoint, apiKey, model, shouldSendTemperature);
          targetAssistant.configEvidence = applyAgentControlPatch(result.controlPatch, requestContext);
          targetAssistant.content = result.content;
          targetAssistant.reasoning = result.reasoning ?? undefined;
          targetAssistant.tokenCount = tokenCountFor(result.content);
          targetAssistant.responseTimeMs = Math.max(0, Date.now() - startTime);
          setMessages([...conversationRef.current]);
          return;
        }

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              ...subset.map((m) => ({ role: m.role, content: m.content })),
            ],
            ...(shouldSendTemperature ? { temperature: 0.2 } : {}),
            stream: true,
          }),
        });

        const contentType = response.headers.get('content-type') || '';
        const supportsStream = response.ok && contentType.includes('text/event-stream');

        // Reset target content while regenerating
        targetAssistant.content = '';
        setMessages([...convo]);

        if (supportsStream && response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';
          let doneStreaming = false;

          const applyDelta = (delta: string) => {
            if (!delta) return;
            targetAssistant.content += delta;
            setMessages([...conversationRef.current]);
          };

          const processEvent = (rawEvent: string) => {
            const lines = rawEvent.split('\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue;
              if (!trimmed.startsWith('data:')) continue;
              const data = trimmed.slice(5).trim();
              if (data === '[DONE]') {
                doneStreaming = true;
                return;
              }
              try {
                const parsed = JSON.parse(data);
                const piece: string | undefined = parsed?.choices?.[0]?.delta?.content;
                if (typeof piece === 'string') {
                  applyDelta(piece);
                }
              } catch {
                // ignore
              }
            }
          };

          while (!doneStreaming) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
              const eventChunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              processEvent(eventChunk);
              if (doneStreaming) break;
              boundary = buffer.indexOf('\n\n');
            }
          }

          if (buffer && !doneStreaming) {
            processEvent(buffer);
          }
          targetAssistant.tokenCount = tokenCountFor(targetAssistant.content);
          targetAssistant.responseTimeMs = Math.max(0, Date.now() - startTime);
          conversationRef.current = [...conversationRef.current];
          setMessages([...conversationRef.current]);
        } else {
          if (!response.ok) {
            throw new Error(await extractAiErrorMessage(response, t));
          }
          const payload = await response.json();
          const assistantText: string | undefined = payload?.choices?.[0]?.message?.content?.trim();
          if (!assistantText) {
            throw new Error('The AI service returned an empty response.');
          }
          targetAssistant.content = assistantText;
          targetAssistant.tokenCount = tokenCountFor(assistantText);
          targetAssistant.responseTimeMs = Math.max(0, Date.now() - (startTime));
          setMessages([...conversationRef.current]);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unexpected error while contacting the AI service.';
        setError(message);
      } finally {
        setIsLoading(false);
        setStreamingMessageId(null);
        requestInFlightRef.current = false;
      }
    },
    [applyAgentControlPatch, captureRequestContext, runAgentModeTurn, systemPrompt, t],
  );

  const handleRegenerate = (message: AiChatMessage) => {
    if (message.role !== 'assistant' || !message.parentUserId) return;
    const convo = conversationRef.current;
    const assistantIndex = convo.findIndex((m) => m.id === message.id);
    const userIndex = convo.findIndex((m) => m.id === message.parentUserId);
    if (assistantIndex === -1 || userIndex === -1) return;
    void regenerateAssistantForUserIndex(userIndex, assistantIndex);
  };

  const handleEditClick = (message: AiChatMessage) => {
    if (message.role !== 'user') return;
    setEditingId(message.id);
    setEditDraft(message.content);
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditDraft('');
  };

  const handleEditSave = () => {
    if (!editingId) return;
    const trimmed = editDraft.trim();
    if (!trimmed) return;
    const convo = conversationRef.current;
    const userIndex = convo.findIndex((m) => m.id === editingId);
    if (userIndex === -1) return;

    // Update the user message content
    convo[userIndex] = {
      ...convo[userIndex],
      content: trimmed,
    };
    setMessages([...convo]);

    // Find the assistant reply tied to this user message
    const assistantIndex = convo.findIndex((m) => m.role === 'assistant' && m.parentUserId === editingId);
    if (assistantIndex !== -1) {
      void regenerateAssistantForUserIndex(userIndex, assistantIndex);
    }

    setEditingId(null);
    setEditDraft('');
  };

  useEffect(() => {
    const selectionContext = rawData?.sheets?.length
      ? `${rawData.fileName || 'dataset'}::${rawData.sheets.map((sheet) => sheet.name).join('|')}`
      : rawData?.fileName ?? null;

    if (sheetSelectionContextRef.current === selectionContext) {
      return;
    }

    sheetSelectionContextRef.current = selectionContext;

    if (rawData?.sheets && rawData.sheets.length > 1) {
      setSelectedAiSheetIndex(null);
      appendWorksheetSelectionMessage();
    } else {
      setSelectedAiSheetIndex(rawData ? (rawData.activeSheetIndex ?? 0) : null);
    }
  }, [appendWorksheetSelectionMessage, rawData]);

  useEffect(() => {
    if (!hasInitialized && !initializationStartedRef.current) {
      // StrictMode replays this effect before its state update; reserve initialization synchronously.
      initializationStartedRef.current = true;
      if (rawData && datasetSummary) {
        if (rawData.sheets && rawData.sheets.length > 1 && selectedAiSheetIndex === null) {
          const welcomeMessage: AiChatMessage = {
            id: 'assistant-welcome-multisheet',
            role: 'assistant',
            content: t('ai.welcomeMessage'),
            createdAt: Date.now(),
            autoGenerated: true,
          };

          const sheetMessage: AiChatMessage = {
            id: `assistant-sheets-initial-${Date.now()}`,
            role: 'assistant',
            content: t('ai.selectWorksheetPrompt'),
            createdAt: Date.now(),
            autoGenerated: true,
            worksheetOptions,
          };

          conversationRef.current = [welcomeMessage, sheetMessage];
          setMessages([welcomeMessage, sheetMessage]);
          setHasInitialized(true);
          return;
        }

        lastSummaryRef.current = datasetSummary;
        setHasInitialized(true);
        void sendMessage(buildInitialUserPrompt(datasetSummary, selectedChartType, friendlyChartName, language), {
          skipInputReset: true,
          autoGenerated: true,
          attachment: datasetAttachment,
        });
      } else {
        const welcomeMessage: AiChatMessage = {
          id: 'assistant-welcome',
          role: 'assistant',
          content:
            t('ai.welcomeMessage'),
          createdAt: Date.now(),
          autoGenerated: true,
        };
        conversationRef.current = [welcomeMessage];
        setMessages([welcomeMessage]);
        setHasInitialized(true);
      }
    }
  }, [datasetAttachment, datasetSummary, friendlyChartName, hasInitialized, rawData, selectedAiSheetIndex, selectedChartType, sendMessage, language, t, worksheetOptions]);

  useEffect(() => {
    if (!hasInitialized || !datasetSummary) {
      return;
    }

    if (agentModeEnabled) {
      return;
    }

    if (rawData?.sheets && rawData.sheets.length > 1 && selectedAiSheetIndex === null) {
      return;
    }

    if (lastSummaryRef.current === datasetSummary) {
      return;
    }

    lastSummaryRef.current = datasetSummary;
    void sendMessage(buildDatasetUpdatePrompt(datasetSummary, language), {
      skipInputReset: true,
      autoGenerated: true,
      attachment: datasetAttachment,
    });
  }, [agentModeEnabled, datasetAttachment, datasetSummary, hasInitialized, language, rawData?.sheets, selectedAiSheetIndex, sendMessage]);

  useEffect(() => {
    if (!hasInitialized) {
      return;
    }

    if (rawData) {
      return;
    }

    if (lastSummaryRef.current === null) {
      return;
    }

    lastSummaryRef.current = null;
    appendAssistantMessage(
      t('ai.datasetCleared'),
    );
  }, [appendAssistantMessage, hasInitialized, rawData, t]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    // Do not yank the view back down while the reader has scrolled up to re-read something.
    if (!container || !stickToBottomRef.current) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!agentModeEnabled) {
      setAgentFeedback(null);
      agentAutopilotContextRef.current = null;
      suppressNextAgentAutopilotRef.current = false;
    }
  }, [agentModeEnabled]);

  useEffect(() => {
    if (!agentModeEnabled || !hasInitialized || !datasetSummary || requiresWorksheetSelection || isLoading) {
      return;
    }

    const contextSignature = `${selectedAiSheetIndex ?? -1}::${datasetSummary}`;

    if (suppressNextAgentAutopilotRef.current) {
      if (agentAutopilotContextRef.current !== contextSignature) {
        // Data has actually changed – consume the suppress flag and cache the new signature
        suppressNextAgentAutopilotRef.current = false;
        agentAutopilotContextRef.current = contextSignature;
      }
      return;
    }

    if (agentAutopilotContextRef.current === contextSignature) {
      return;
    }

    agentAutopilotContextRef.current = contextSignature;
    void sendMessage(buildAgentAutopilotPrompt(datasetSummary, selectedChartType, friendlyChartName, language), {
      skipInputReset: true,
      autoGenerated: true,
      hideUserMessage: true,
      attachment: datasetAttachment,
    });
  }, [
    agentModeEnabled,
    datasetAttachment,
    datasetSummary,
    friendlyChartName,
    hasInitialized,
    isLoading,
    language,
    requiresWorksheetSelection,
    selectedAiSheetIndex,
    selectedChartType,
    sendMessage,
  ]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    void sendMessage(inputValue);
  };

  const visibleMessages = useMemo(() => {
    const hiddenAutoUserIds = new Set<string>();

    return messages.filter((message) => {
      if (message.hidden) {
        return false;
      }

      if (agentModeEnabled && message.role === 'user' && message.autoGenerated && message.agentModeRequest) {
        hiddenAutoUserIds.add(message.id);
        return false;
      }

      if (
        agentModeEnabled
        && message.role === 'assistant'
        && message.parentUserId
        && hiddenAutoUserIds.has(message.parentUserId)
        && !message.agentModeRequest
      ) {
        return false;
      }

      return true;
    });
  }, [agentModeEnabled, messages]);

  const lastVisibleMessageId = visibleMessages[visibleMessages.length - 1]?.id;
  const latestEvidenceId = useMemo(() => {
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      if (visibleMessages[index].configEvidence) return visibleMessages[index].id;
    }
    return null;
  }, [visibleMessages]);

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    stickToBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < STICK_TO_BOTTOM_PX;
  };

  return (
    <div className="mt-4 overflow-hidden rounded-2xl border border-teal-100 bg-white shadow-inner" dir={language === 'he' ? 'rtl' : 'ltr'}>
      <div className="flex items-start justify-between border-b border-teal-100 bg-teal-50/60 px-4 py-3">
        <div className="flex items-center gap-2 text-teal-700">
          <Sparkles className="h-5 w-5" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">{t('ai.title')}</p>
            <p className="text-xs text-gray-600">{t('ai.subtitle')}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-gray-500 transition hover:text-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600"
          aria-label={t('ai.close')}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {error && (
        <div role="alert" className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {agentFeedback && (
        <div role="status" className="border-b border-teal-100 bg-teal-50 px-4 py-2 text-xs text-teal-800">
          {agentFeedback}
        </div>
      )}

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label={t('ai.conversation')}
        tabIndex={0}
        className="assistant-log max-h-[min(34rem,65vh)] min-h-[10rem] space-y-3 overflow-y-auto px-4 py-4 text-sm"
      >
        {visibleMessages.map((message) => {
          const isAssistant = message.role === 'assistant';
          const hasAttachment = Boolean(message.attachment);
          const hasWorksheetOptions = Boolean(message.worksheetOptions?.length);
          const isStreaming = isLoading && isAssistant && (streamingMessageId === message.id || (streamingMessageId === null && message.id === lastVisibleMessageId));
          const bubbleBase = isAssistant
            ? 'bg-teal-50 text-gray-700 ring-1 ring-inset ring-teal-100 rounded-bl-none'
            : 'bg-teal-600 text-white rounded-br-none';
          const bubblePadding = hasAttachment && !isAssistant ? 'p-3' : 'px-3 py-2';
          const bubbleWhitespace = isAssistant || hasAttachment ? 'whitespace-normal' : 'whitespace-pre-wrap';
          const actionColor = isAssistant
            ? 'text-teal-700 hover:bg-teal-100 hover:text-teal-900'
            : 'text-white/90 hover:bg-white/15 hover:text-white';
          const metricColor = isAssistant ? 'text-teal-800' : 'text-white/90';
          const attachmentMetaParts: string[] = [];
          if (message.attachment?.type) {
            attachmentMetaParts.push(message.attachment.type.toUpperCase());
          }
          if (message.attachment?.rows !== undefined && message.attachment?.columns !== undefined) {
            attachmentMetaParts.push(
              `${message.attachment.rows} ${t('fileUpload.rows')} • ${message.attachment.columns} ${t('fileUpload.columns')}`,
            );
          }
          const attachmentMeta = attachmentMetaParts.join(' · ');
          const showEdit = !isAssistant && !message.autoGenerated && !hasAttachment;
          const wideAssistant = isAssistant && (Boolean(message.configEvidence) || message.content.includes('```html'));
          const actionButton = `rounded-md p-1.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current disabled:opacity-50 ${actionColor}`;
          return (
            <div key={message.id} className={`flex ${isAssistant ? 'justify-start' : 'justify-end'}`}>
              <div className={`min-w-0 ${isAssistant ? (wideAssistant ? 'w-[min(100%,44rem)]' : 'max-w-[92%]') : 'max-w-[85%]'}`}>
                <div
                  className={`relative rounded-2xl ${bubblePadding} shadow-xs ${bubbleBase} ${bubbleWhitespace}`}
                >
                  {isAssistant ? (
                    <>
                      {message.reasoning && (
                        <ChainOfThought className="mb-3">
                          <ChainOfThoughtHeader>{t('ai.thinking')}</ChainOfThoughtHeader>
                          <ChainOfThoughtContent>
                            <ChainOfThoughtStep label={t('ai.thinking')} status="complete">
                              <div className="text-xs whitespace-pre-wrap text-gray-600 dark:text-gray-400">
                                {message.reasoning}
                              </div>
                            </ChainOfThoughtStep>
                          </ChainOfThoughtContent>
                        </ChainOfThought>
                      )}
                      <AssistantMessageContent text={message.content} streaming={isStreaming} />
                      {hasWorksheetOptions && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {message.worksheetOptions?.map((option) => (
                            <button
                              key={`${message.id}-${option.index}`}
                              type="button"
                              onClick={() => handleWorksheetSelect(option.index)}
                              className="rounded-full border border-teal-300 bg-white px-3 py-1 text-xs font-medium text-teal-700 transition hover:bg-teal-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600"
                            >
                              {option.name} ({option.rows} {t('fileUpload.rows')}, {option.columns} {t('fileUpload.columns')})
                            </button>
                          ))}
                        </div>
                      )}
                      {message.configEvidence && (
                        <AgentConfigEvidenceView
                          evidence={message.configEvidence}
                          current={currentConfig}
                          defaultOpen={message.id === latestEvidenceId}
                        />
                      )}
                    </>
                  ) : hasAttachment ? (
                    <div className="flex items-center gap-3 rounded-xl border border-white/30 bg-white/10 px-3 py-2">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/20 text-white">
                        <FileSpreadsheet className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">{message.attachment?.name}</p>
                        {attachmentMeta && (
                          <p className="text-xs text-white/90">{attachmentMeta}</p>
                        )}
                      </div>
                      <span className="sr-only">{message.content}</span>
                    </div>
                  ) : (
                    message.content
                  )}

                  {isAssistant && !isStreaming ? (
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          className={actionButton}
                          onClick={() => handleRegenerate(message)}
                          disabled={isLoading || !message.parentUserId}
                          aria-label={t('ai.regenerate')}
                          title={t('ai.regenerate')}
                        >
                          <RefreshCcw size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className={actionButton}
                          onClick={() => handleCopy(message.id, message.content)}
                          aria-label={copiedId === message.id ? t('ai.copied') : t('ai.copy')}
                          title={copiedId === message.id ? t('ai.copied') : t('ai.copy')}
                        >
                          {copiedId === message.id ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                        </button>
                        <button
                          type="button"
                          className={actionButton}
                          onClick={() => handleDownload(message.content)}
                          aria-label={t('ai.download')}
                          title={t('ai.download')}
                        >
                          <Download size={14} aria-hidden="true" />
                        </button>
                      </div>
                      {(message.tokenCount !== undefined || message.responseTimeMs !== undefined) && (
                        <div className={`flex items-center gap-3 text-[11px] tabular-nums ${metricColor}`}>
                          <span className="flex items-center gap-1">
                            <Hash size={12} aria-hidden="true" />
                            {message.tokenCount ?? '—'}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock size={12} aria-hidden="true" />
                            {message.responseTimeMs !== undefined
                              ? `${(message.responseTimeMs / 1000).toFixed(2)}s`
                              : '—'}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : showEdit ? (
                    <div className="mt-1 flex items-center justify-end">
                      <button
                        type="button"
                        className={actionButton}
                        onClick={() => handleEditClick(message)}
                        aria-label={t('ai.edit')}
                        title={t('ai.edit')}
                      >
                        <Edit3 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}

        {isLoading && (
          <div role="status" className="flex items-center gap-2 text-teal-700">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>{t('ai.thinking')}</span>
          </div>
        )}
      </div>

      {editingId && (
        <div className="border-t border-teal-100 bg-teal-50/40 px-4 py-3">
          <label htmlFor="edit-question" className="block text-xs font-medium text-slate-600 uppercase mb-2">
            {t('ai.editLabel')}
          </label>
          <textarea
            id="edit-question"
            className="w-full rounded-lg border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-100 px-3 py-2 text-sm text-slate-700"
            rows={3}
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-800"
              onClick={handleEditCancel}
            >
              <X size={16} />
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-sm font-medium text-teal-700 hover:text-teal-800 disabled:opacity-60"
              onClick={handleEditSave}
              disabled={editDraft.trim().length === 0}
            >
              <Check size={16} />
              {t('ai.saveChanges')}
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="border-t border-teal-100 bg-white/80 px-4 py-3">
        <label className="sr-only" htmlFor="ai-message">
          {t('ai.title')}
        </label>
        <textarea
          id="ai-message"
          className="h-20 w-full resize-none rounded-xl border border-teal-100 bg-white px-3 py-2 text-sm text-gray-700 shadow-xs focus:border-teal-500 focus:outline-hidden focus:ring-2 focus:ring-teal-200"
          placeholder={t('ai.placeholder')}
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !editingId) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          disabled={isLoading || !!editingId}
        />
        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            className={`rounded-full transition-colors duration-200 flex items-center gap-1.5 px-2 py-1 border h-8 ${agentModeEnabled ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-gray-100 border-gray-300 text-gray-400 hover:bg-gray-200 hover:text-gray-600'}`}
            onClick={() => {
              setAgentModeEnabled((prev) => !prev);
              setAgentFeedback(null);
            }}
            aria-pressed={agentModeEnabled}
            title={agentModeEnabled ? t('ai.agentModeOn') : t('ai.agentModeOff')}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <AnimatePresence initial={false}>
              {agentModeEnabled && (
                <motion.span
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 'auto', opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ duration: 0.15, ease: 'easeInOut' }}
                  className="text-[11px] font-medium overflow-hidden whitespace-nowrap shrink-0"
                >
                  {t('ai.agentModeOn')}
                </motion.span>
              )}
            </AnimatePresence>
          </button>
          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-full bg-teal-600 px-4 py-2 text-sm font-medium text-white shadow-md transition hover:bg-teal-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-500 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isLoading || !!editingId || !inputValue.trim() || requiresWorksheetSelection}
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
            <span>{isLoading ? t('ai.sending') : t('ai.send')}</span>
          </button>
        </div>
        <p className="mt-1 text-end text-[11px] text-teal-800">{t('ai.agentHint')}</p>
      </form>
    </div>
  );
};

export default AiAssistantPanel;
