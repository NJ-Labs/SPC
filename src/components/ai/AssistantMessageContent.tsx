import React, { useMemo } from 'react';
import { MarkdownText } from '../common/MarkdownText';
import { AssistantHtmlFrame, AssistantHtmlPending } from './AssistantHtmlFrame';
import { parseAssistantContent } from './assistantHtml';

interface AssistantMessageContentProps {
  text: string;
  /** The reply is still arriving, so an unclosed html block is expected rather than broken. */
  streaming: boolean;
}

/** Markdown stays markdown; only closed ```html fences become sandboxed frames. */
export const AssistantMessageContent: React.FC<AssistantMessageContentProps> = React.memo(({ text, streaming }) => {
  const blocks = useMemo(() => parseAssistantContent(text), [text]);

  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'markdown') {
          return <MarkdownText key={`md-${index}`} text={block.text} />;
        }
        if (block.type === 'html') {
          return <AssistantHtmlFrame key={`html-${block.artifactIndex}`} html={block.html} artifactIndex={block.artifactIndex} />;
        }
        return <AssistantHtmlPending key={`open-${index}`} html={block.html} streaming={streaming} />;
      })}
    </>
  );
});
AssistantMessageContent.displayName = 'AssistantMessageContent';
