import { forwardRef } from 'react';

const TranscriptFeed = forwardRef(function TranscriptFeed({
  audioDebug,
  feedItems,
  formatTime,
  onScroll,
  styles,
}, ref) {
  return (
    <>
      <div style={styles.transcriptHeader}>
        <div>
          <div style={styles.cardLabel}>Transcript</div>
          <div style={styles.cardHint}>Draft line appears first, then settles into history.</div>
        </div>

        <div style={styles.debugChip}>
          {audioDebug.lastBytes ? `Audio ${audioDebug.lastBytes}b` : 'Audio idle'}
        </div>
      </div>

      <div
        ref={ref}
        aria-live="polite"
        aria-relevant="additions text"
        role="log"
        className="scroll-premium"
        onScroll={onScroll}
        style={styles.transcriptFeed}
      >
        {feedItems.length === 0 ? (
          <div style={styles.emptyState}>Waiting for speech…</div>
        ) : (
          feedItems.map((item) => (
            <div
              key={item.id}
              style={{
                ...styles.feedRow,
                ...(item.isLive ? styles.feedRowLive : {}),
              }}
            >
              <div style={styles.feedMetaRow}>
                <div style={styles.feedMetaLeft}>
                  <div style={styles.feedMeta}>{item.time}</div>
                  {!item.isLive && item.at ? (
                    <div style={styles.feedTimePill}>{formatTime(item.at)}</div>
                  ) : null}
                </div>

                {item.isLive && <div style={styles.liveBadge}>Draft</div>}
              </div>

              <div style={styles.feedChinese}>{item.chinese || '…'}</div>

              <div
                style={{
                  ...styles.feedEnglish,
                  ...(item.isLive ? styles.feedEnglishDraft : {}),
                }}
              >
                {item.english || (item.isLive ? 'Translating…' : '…')}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
});

export default TranscriptFeed;
