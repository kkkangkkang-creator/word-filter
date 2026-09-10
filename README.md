# Word Filter for SillyTavern

Remove or replace literal expressions in AI messages, with display-only filtering, optional source updates, and reversible backups.

AI 메시지의 표현을 삭제하거나 치환하는 SillyTavern 확장입니다. 화면에만 적용하거나 실제 채팅 원문을 변경할 수 있으며, 변경된 원문은 백업으로 복원할 수 있습니다.

- [English](#english)
- [한국어](#한국어)

## English

### Installation

In SillyTavern's extension installer, enter:

```text
https://github.com/kkkangkkang-creator/word-filter
```

For manual installation, place the repository files in `SillyTavern/public/scripts/extensions/third-party/word-filter/`, then restart SillyTavern. Keep the folder name `word-filter`, which the fallback template loader uses.

Open **Word Filter** from the chat's extensions menu.

### Rules and matching

- Add deletion terms separated by commas or line breaks. Replacement rules have a source and a destination; an empty destination deletes the source.
- Rules match literal text, not user-written regular expressions. Terms consisting only of ASCII letters, digits, or underscores use regex word boundaries (`\b`); other terms match literal substrings.
- Matching is case-insensitive by default. The case-sensitive option changes matching, but the add-rule interface still rejects duplicates that differ only in case.
- Replacement rules run from top to bottom, followed by deletion rules. Earlier replacements can produce text matched by later rules.
- Optional space cleanup reduces runs of two or more spaces/tabs to one space and preserves line breaks. It runs when the filter is enabled and at least one rule exists, even if no term matches.
- Language groups organize lists and exports; they do not restrict which rules run on a message. Automatic grouping checks Hangul, Japanese kana, Han characters, and Latin characters in that order, then uses “Other.” Custom groups are supported.

### Display-only mode

This is the default mode. The extension renders filtered text without changing stored chat text or the history sent to the model. Editing a message opens its stored text.

Visible AI messages are refreshed after chat changes and older messages load. Requests are queued by message ID, and cached results avoid repeated filtering of unchanged text. User and system messages are excluded; a compatibility exception recognizes certain summarized assistant messages.

Turning the filter off restores the unfiltered display. Text already changed in source mode requires backup restoration.

### Source mode and batch application

**Save to source for new AI messages** filters messages on receive, edit, and swipe events, updating the current message and active swipe. Opening a chat or loading older messages does not trigger a source batch operation. Edits establish a new original; if a source event finds a backup conflict, it uses the current text as the new original.

**Apply to current chat** is a separate, confirmed action. With the filter enabled and rules present, it processes all eligible AI messages in the current chat data, including the body and every stored swipe, regardless of how many messages are visible. It skips conflicting backups, reuses filter results for identical originals, and requests one chat save when message text changes.

Batch application and restoration do not automatically redraw the entire chat. Use **Refresh current view** or reopen the chat to see the saved result.

### Backups and restoration

Source changes store restoration data in each message's metadata. The extension compares a reversible edit patch with a full original copy and stores the smaller serialized representation. Hashes detect changes to backed-up text.

**Restore original** restores available backups, then turns off filtering and source mode when entries were restored. Conflicting current-format entries are skipped. Legacy settings and backups are supported, but older full-text backups lack the current hash checks. Keep a separate chat backup before making bulk source changes.

### Export and import

- Export deletion terms, replacement source terms, or both, optionally filtered by language group, as `term1|term2|term3` for copying or TXT download.
- Regex escaping is enabled by default. This export is a list of alternatives; it does not include the filter's word-boundary logic, matching flags, or replacement destinations.
- JSON export saves rules, groups, and settings. JSON import replaces the current extension settings. Message restoration data belongs to the chat and is not included in this settings export.

## 한국어

### 설치

SillyTavern의 확장 설치 화면에 다음 주소를 입력합니다.

```text
https://github.com/kkkangkkang-creator/word-filter
```

수동 설치 시 저장소 파일을 `SillyTavern/public/scripts/extensions/third-party/word-filter/`에 넣고 SillyTavern을 다시 시작합니다. 템플릿 대체 로더가 사용하는 폴더 이름은 `word-filter`로 유지합니다.

채팅의 확장 메뉴에서 **Word Filter**를 엽니다.

### 규칙과 매칭 방식

- 삭제 단어는 쉼표나 줄바꿈으로 여러 개를 추가할 수 있습니다. 치환 규칙은 원문과 결과를 입력하며, 결과를 비우면 원문을 삭제합니다.
- 입력한 표현은 정규식이 아닌 일반 문자열로 처리합니다. 영문 ASCII 문자·숫자·밑줄만으로 된 표현에는 정규식 단어 경계(`\b`)를 적용하고, 나머지는 부분 문자열로 찾습니다.
- 기본값은 대소문자 구분 없음입니다. 대소문자 구분 옵션은 매칭에 적용되지만, 규칙 추가 화면에서는 대소문자만 다른 중복 항목을 허용하지 않습니다.
- 치환 규칙을 위에서 아래로 적용한 뒤 삭제 규칙을 적용합니다. 앞선 치환 결과가 뒤쪽 규칙에 다시 매칭될 수 있습니다.
- 연속 공백 정리를 켜면 두 개 이상 이어진 공백·탭을 공백 하나로 줄이고 줄바꿈은 유지합니다. 필터가 켜져 있고 규칙이 하나 이상 있으면, 단어가 매칭되지 않아도 공백 정리를 수행합니다.
- 언어 그룹은 목록 정리와 내보내기용이며, 메시지에 적용할 규칙을 제한하지 않습니다. 자동 분류는 한글 → 일본어 가나 → 한자 → 라틴 문자 순서로 확인하고, 해당하지 않으면 기타로 분류합니다. 사용자 그룹도 추가할 수 있습니다.

### 표시 전용 모드

기본 모드입니다. 저장된 채팅 원문이나 모델에 전달되는 기록을 변경하지 않고 화면에만 필터 결과를 표시합니다. 메시지를 수정할 때는 저장된 본문이 열립니다.

채팅을 전환하거나 과거 메시지를 불러오면 보이는 AI 메시지를 갱신합니다. 메시지 ID별로 표시 요청을 모으고, 같은 원문에 대한 결과는 캐시로 재사용합니다. 사용자·시스템 메시지는 제외하며, 일부 요약된 AI 메시지를 판별하는 호환 처리가 있습니다.

필터를 끄면 표시 효과를 제거합니다. 원문 저장 모드로 이미 바뀐 내용은 백업 복원이 필요합니다.

### 원문 저장 모드와 일괄 적용

**새 AI 메시지의 원문에 저장**을 켜면 수신·편집·스와이프 이벤트에서 현재 본문과 활성 스와이프를 변경합니다. 채팅을 열거나 과거 메시지를 불러오는 것만으로 기존 원문 전체를 변경하지 않습니다. 편집 내용은 새로운 원문으로 취급하며, 원문 처리 이벤트에서 백업 충돌이 발견되어도 현재 내용을 새 원문으로 사용합니다.

**현재 채팅 원문 변경**은 별도의 확인을 거치는 일괄 작업입니다. 필터가 켜져 있고 규칙이 있으면 화면에 보이는 개수와 관계없이 현재 채팅 데이터의 모든 대상 AI 메시지 본문과 저장된 스와이프를 처리합니다. 백업 충돌 항목은 건너뛰고, 동일한 원문의 필터 결과를 재사용하며, 본문 변경이 있으면 채팅 저장을 한 번 요청합니다.

일괄 적용·복원 후에는 채팅 전체를 자동으로 다시 그리지 않습니다. **현재 화면 새로고침**을 누르거나 채팅을 다시 열면 저장 결과를 확인할 수 있습니다.

### 백업과 복원

원문 변경 시 각 메시지의 메타데이터에 복원 정보를 저장합니다. 되돌릴 수 있는 변경 기록과 전체 원문 사본의 직렬화 크기를 비교해 더 작은 쪽을 사용하며, 해시로 백업 대상 텍스트의 변경 여부를 확인합니다.

**원문 복원**은 사용 가능한 백업을 복원하고, 복원된 항목이 있으면 필터와 원문 저장 모드를 끕니다. 현재 형식의 백업과 충돌하는 항목은 건너뜁니다. 구버전 설정·백업도 지원하지만, 오래된 전체 원문 백업에는 현재 형식의 해시 검증이 없습니다. 원문을 일괄 변경하기 전에는 채팅을 별도로 백업해 두는 것이 좋습니다.

### 내보내기와 가져오기

- 삭제 단어·치환 원문 중 원하는 대상을 선택하고, 언어 그룹별로 `단어1|단어2|단어3` 형태의 텍스트를 복사하거나 TXT로 저장할 수 있습니다.
- 정규식 특수문자 이스케이프는 기본으로 켜져 있습니다. 내보내기는 선택지 목록이며, 실제 필터의 단어 경계·매칭 플래그·치환 결과는 포함하지 않습니다.
- JSON 내보내기는 규칙·그룹·설정을 저장합니다. JSON 가져오기는 현재 확장 설정을 교체합니다. 메시지 원문 복원 정보는 채팅에 저장되며 설정 JSON에는 포함되지 않습니다.
