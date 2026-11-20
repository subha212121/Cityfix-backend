# CityFix – design diagrams (Mermaid source)

Editable versions are on the FigJam board: https://www.figma.com/board/1g3DsXNjakjDH4c3USGKjs
These sources render on GitHub, in VS Code (Mermaid preview) and at mermaid.live.

## 1. Incident lifecycle flowchart

```mermaid
flowchart LR
    subgraph citizenLane ["Citizen app"]
        start([Citizen spots an issue])
        form[/"Title, photos, location, description"/]
        valid{Form valid?}
        formErr["Show field errors (E2)"]
        ack["Report submitted with INC number (C9)"]
        citizenReply{Citizen response?}
    end
    subgraph systemLane ["System"]
        aiUp{AI available?}
        aiSuggest["AI suggests category, priority and reason"]
        manualCat["Citizen picks category (E3 fallback)"]
        save[("Save incident, set ward and SLA")]
        notify[/"Notify citizen in-app and email"/]
        autoClose["Auto-close after 7 days"]
    end
    subgraph officerLane ["Council officer"]
        review["Review incident (O2)"]
        dup{Duplicate?}
        merge["Merge into primary incident"]
        validIssue{Council issue?}
        aiCheck{Keep AI values?}
        override["Override category or priority"]
        assign["Assign team or crew"]
        work["In Progress"]
        resolved["Resolved with note"]
    end
    closedDup([Closed as duplicate])
    rejected([Rejected with reason])
    closed([Closed])

    start --> form --> valid
    valid -->|"No"| formErr --> form
    valid -->|"Yes"| aiUp
    aiUp -->|"Yes"| aiSuggest --> save
    aiUp -->|"No or timeout"| manualCat --> save
    save --> ack
    save --> review --> dup
    dup -->|"Yes"| merge --> closedDup
    dup -->|"No"| validIssue
    validIssue -->|"No"| rejected
    validIssue -->|"Yes"| aiCheck
    aiCheck -->|"Accept"| assign
    aiCheck -->|"Change"| override --> assign
    assign --> work --> resolved --> citizenReply
    citizenReply -->|"Confirms and rates"| closed
    citizenReply -->|"Not fixed, reopen"| work
    citizenReply -->|"No reply"| autoClose --> closed
    assign -.->|"Status change"| notify
    work -.->|"Status change"| notify
    resolved -.->|"Ask for rating"| notify
    rejected -.-> notify
```

## 2. Use-case diagram

Mermaid has no UML use-case type, so this uses a flowchart: circles are actors, rounded boxes are use cases, dotted arrows are «include»/«extend».

```mermaid
flowchart LR
    citizen((Citizen))
    officer((Council officer))
    admin((Admin))
    aiService((AI service))
    scheduler((Scheduler))
    emailService((Email service))
    subgraph sys ["CityFix system"]
        subgraph account ["Account"]
            ucSignUp([Register and verify email])
            ucSignIn([Sign in with role check])
            ucReset([Reset password])
            ucProfile([Manage profile and notification settings])
        end
        subgraph reporting ["Reporting and tracking"]
            ucReport([Report an issue])
            ucPhotos([Attach up to 3 photos])
            ucLocation([Set location by GPS or pin])
            ucAnon([Report anonymously])
            ucMap([Browse incident map])
            ucSupport([Mark I see this too])
            ucTrack([Track my reports and status])
            ucMessage([Message the council])
            ucRate([Rate fix or reopen])
            ucChat([Ask the help chatbot])
            ucNotify([Receive notifications])
        end
        subgraph handling ["Incident handling"]
            ucQueue([View work queue and map])
            ucReview([Review and triage incident])
            ucMerge([Merge duplicates])
            ucAiDecide([Accept or override AI])
            ucAssign([Assign team or crew])
            ucUpdate([Update status and notify])
            ucHandover([Answer chatbot hand-over])
            ucStats([View workload and stats])
            ucAutoClose([Auto-close and SLA alerts])
        end
        subgraph administration ["Administration"]
            ucAnalytics([View city analytics and heatmap])
            ucUsers([Manage users, roles and invites])
            ucCats([Manage categories and SLAs])
            ucAiSet([Configure AI features])
            ucAudit([Review audit log])
            ucExport([Export CSV or PDF reports])
        end
    end
    citizen --- ucSignUp & ucSignIn & ucProfile & ucReport & ucMap & ucSupport & ucTrack & ucMessage & ucRate & ucChat & ucNotify
    ucReport -.->|"includes"| ucLocation
    ucReport -.->|"extends"| ucPhotos
    ucReport -.->|"extends"| ucAnon
    ucSignIn -.->|"extends"| ucReset
    officer --- ucSignIn & ucQueue & ucReview & ucMerge & ucAiDecide & ucAssign & ucUpdate & ucHandover & ucStats
    admin --- ucAssign & ucAnalytics & ucUsers & ucCats & ucAiSet & ucAudit & ucExport
    aiService --- ucReport & ucReview & ucChat & ucAnalytics
    scheduler --- ucAutoClose
    emailService --- ucNotify & ucReset
```

## 3a. ERD – incidents and workflow

```mermaid
erDiagram
    USERS ||--o{
        INCIDENTS : reports
    USERS |o..o{
        INCIDENTS : handles
    CATEGORIES ||--o{
        INCIDENTS : classifies
    CATEGORIES |o..o{
        CATEGORIES : parent_of
    CATEGORIES ||--o{
        SLA_PRIORITY_OVERRIDES : has
    DEPARTMENTS ||--o{
        CATEGORIES : routes
    DEPARTMENTS ||--o{
        TEAMS : has
    DEPARTMENTS |o..o{
        USERS : employs
    TEAMS |o..o{
        INCIDENTS : works_on
    WARDS |o..o{
        INCIDENTS : contains
    INCIDENTS |o..o{
        INCIDENTS : merged_into
    INCIDENTS ||--o{
        INCIDENT_STATUS_HISTORY : logs
    INCIDENTS ||--o{
        INCIDENT_ASSIGNMENTS : tracks
    INCIDENTS ||--o{
        INCIDENT_SUPPORTERS : supported_by
    USERS ||--o{
        INCIDENT_SUPPORTERS : supports
    INCIDENTS ||--o{
        INCIDENT_MESSAGES : has
    INCIDENTS ||--o{
        INCIDENT_ATTACHMENTS : has
    INCIDENT_MESSAGES |o..o{
        INCIDENT_ATTACHMENTS : attaches
    INCIDENTS ||--o{
        INCIDENT_RATINGS : rated_by
    USERS {
        uuid id PK
        string email UK
        string full_name
        enum role
        enum status
        smallint department_id FK
        smallint team_id FK
    }
    DEPARTMENTS {
        smallint id PK
        string name UK
        string code UK
    }
    TEAMS {
        smallint id PK
        smallint department_id FK
        string name
        bool is_field_crew
    }
    WARDS {
        smallint id PK
        string name UK
        geometry boundary
    }
    CATEGORIES {
        smallint id PK
        smallint parent_id FK
        string name
        smallint default_department_id FK
        smallint default_team_id FK
        smallint sla_days
    }
    SLA_PRIORITY_OVERRIDES {
        smallint category_id PK, FK
        enum priority PK
        int sla_hours
    }
    INCIDENTS {
        bigint id PK
        string reference_no UK
        uuid reporter_id FK
        bool is_anonymous
        geography location
        smallint ward_id FK
        smallint category_id FK
        enum priority
        smallint ai_category_id FK
        enum ai_priority
        enum status
        smallint assigned_team_id FK
        uuid assigned_officer_id FK
        datetime sla_due_at
        bigint merged_into_id FK
        smallint reopen_count
    }
    INCIDENT_STATUS_HISTORY {
        bigint id PK
        bigint incident_id FK
        enum from_status
        enum to_status
        uuid changed_by FK
        text note
    }
    INCIDENT_ASSIGNMENTS {
        bigint id PK
        bigint incident_id FK
        smallint team_id FK
        uuid officer_id FK
        datetime ended_at
    }
    INCIDENT_SUPPORTERS {
        bigint incident_id PK, FK
        uuid user_id PK, FK
    }
    INCIDENT_MESSAGES {
        bigint id PK
        bigint incident_id FK
        uuid sender_id FK
        text body
        bool is_internal
    }
    INCIDENT_ATTACHMENTS {
        uuid id PK
        bigint incident_id FK
        bigint message_id FK
        enum kind
        string storage_key UK
        int size_bytes
    }
    INCIDENT_RATINGS {
        bigint id PK
        bigint incident_id FK
        uuid citizen_id FK
        smallint score
        bool requested_reopen
    }
```

`incident_status_transitions` is a rule table with no foreign keys, so it is not drawn.

## 3b. ERD – accounts and notifications

```mermaid
erDiagram
    USERS ||--o{
        AUTH_TOKENS : has
    USERS ||--o{
        USER_SESSIONS : signs_in
    USERS ||--o{
        DEVICE_PUSH_TOKENS : registers
    USERS ||--o{
        NOTIFICATION_PREFERENCES : sets
    USERS ||--o{
        NOTIFICATIONS : receives
    USERS ||--o{
        STAFF_INVITATIONS : sends
    DEPARTMENTS |o..o{
        STAFF_INVITATIONS : for
    INCIDENTS |o..o{
        NOTIFICATIONS : about
    NOTIFICATIONS ||--o{
        NOTIFICATION_DELIVERIES : sent_via
```

## 3c. ERD – AI, chatbot and administration

```mermaid
erDiagram
    INCIDENTS |o..o{
        AI_PREDICTIONS : analysed_by
    CATEGORIES |o..o{
        AI_PREDICTIONS : suggested_in
    USERS |o..o{
        AI_PREDICTIONS : decides
    AI_SETTINGS ||..o{
        AI_PREDICTIONS : governs
    AI_PREDICTIONS |o..o{
        ANALYTICS_SUMMARIES : writes
    WARDS |o..o{
        ANALYTICS_SUMMARIES : covers
    USERS ||--o{
        CHAT_CONVERSATIONS : starts
    INCIDENTS |o..o{
        CHAT_CONVERSATIONS : about
    CHAT_CONVERSATIONS ||--o{
        CHAT_MESSAGES : contains
    AI_PREDICTIONS |o..o{
        CHAT_MESSAGES : answers
    USERS ||--o{
        EXPORT_JOBS : requests
    USERS |o..o{
        APP_FEEDBACK : sends
    USERS |o..o{
        AUDIT_LOGS : performs
    CATEGORIES |o..o{
        FAQ_ARTICLES : groups
```

Full columns for 3b and 3c are in `db/schema.sql` and on the FigJam board.

## 4a. Sequence – citizen submits a report

```mermaid
sequenceDiagram
    participant Citizen
    participant MobileApp
    participant API
    participant ObjectStorage
    participant AIService
    participant Database
    participant NotifyWorker
    Citizen->>MobileApp: Fill title, description, pin, photos
    MobileApp->>API: POST /uploads/presign
    API-->>MobileApp: Signed upload URLs
    MobileApp->>ObjectStorage: PUT photos, max 3 x 5 MB
    MobileApp->>API: POST /ai/suggest
    API->>AIService: Classify text and photo
    AIService-->>API: Category, priority, reason, confidence
    API-->>MobileApp: Suggestion or manual fallback
    Citizen->>MobileApp: Confirm and submit
    MobileApp->>API: POST /incidents
    API->>Database: INSERT incident, photos, ai_prediction
    Database-->>API: INC number, ward, SLA due date
    API->>Database: INSERT notification and outbox row
    API-->>MobileApp: 201 Created with INC number
    MobileApp-->>Citizen: Report submitted screen
    NotifyWorker->>Database: Poll queued deliveries
    NotifyWorker->>Citizen: Confirmation email and push
```

## 4b. Sequence – officer updates, citizen rates or reopens

```mermaid
sequenceDiagram
    participant Officer
    participant WebDashboard
    participant API
    participant Database
    participant NotifyWorker
    participant MobileApp
    participant Citizen
    Officer->>WebDashboard: Open incident from work queue
    WebDashboard->>API: GET /incidents/42
    API->>Database: SELECT incident, history, AI summary, duplicates
    Database-->>API: Incident details
    API-->>WebDashboard: 200 incident
    Officer->>WebDashboard: Assign crew, set In Progress, add note
    WebDashboard->>API: PATCH /incidents/42
    API->>Database: UPDATE incident, trigger checks transition
    Database-->>API: History and audit rows written
    API->>Database: Queue notification for reporter
    API-->>WebDashboard: 200 updated
    NotifyWorker->>MobileApp: Push status changed
    Citizen->>MobileApp: Open report after Resolved
    Citizen->>MobileApp: Rate 1 to 5 or reopen
    MobileApp->>API: POST /incidents/42/rating
    API->>Database: INSERT rating, UPDATE status
    API-->>MobileApp: 200 closed or reopened
```
