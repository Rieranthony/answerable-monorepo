{{/* The public origin of a hostname: https://<host>, with the port when it is not 443. */}}
{{- define "answerable.origin" -}}
https://{{ .host }}{{ with .root.Values.publicPort }}:{{ . }}{{ end }}
{{- end -}}

{{- define "answerable.idUrl" -}}
{{ include "answerable.origin" (dict "root" . "host" .Values.hostnames.id) }}
{{- end -}}

{{- define "answerable.toolboxUrl" -}}
{{ include "answerable.origin" (dict "root" . "host" .Values.hostnames.toolbox) }}
{{- end -}}

{{- define "answerable.adminMcpUrl" -}}
{{ include "answerable.origin" (dict "root" . "host" .Values.hostnames.adminMcp) }}
{{- end -}}

{{/*
The MCPs charts/answerable/mcps.json declares, as JSON that fromJsonArray reads back: each one's name, serve (toolbox, standalone or
both), database (shared or own) and scopes, its manifest's, which the ops register Job gives a standalone MCP's resource. bun mcp writes
the file from each MCP's mcp.json and manifest, with an object root: fromJson turns an array into an error map, which would read as no
MCP at all, so anything but { "mcps": [...] } fails the render.
*/}}
{{- define "answerable.mcps" -}}
{{- $file := .Files.Get "mcps.json" | fromJson -}}
{{- if not (hasKey $file "mcps") -}}
{{- fail "charts/answerable/mcps.json must be { \"mcps\": [...] }, as bun mcp writes it" -}}
{{- end -}}
{{- $mcps := list -}}
{{- range $file.mcps -}}
{{- $mcps = append $mcps (dict "name" .name "serve" .serve "database" .database "scopes" .scopes) -}}
{{- end -}}
{{- toJson $mcps -}}
{{- end -}}

{{/* Selector labels of a component: the stable subset of its labels. */}}
{{- define "answerable.selectorLabels" -}}
app.kubernetes.io/name: answerable
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "answerable.labels" -}}
{{ include "answerable.selectorLabels" . }}
app.kubernetes.io/part-of: answerable
app.kubernetes.io/version: {{ .root.Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
{{- end -}}

{{/* An image of ours: by digest when one is given, else at the release's tag. */}}
{{- define "answerable.image" -}}
{{- $image := index .root.Values.images .name -}}
{{- with $image.digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" .) -}}
{{- fail (printf "images.%s.digest must be sha256: and 64 lower-case hex digits" $.name) -}}
{{- end -}}
{{ $image.repository }}@{{ . }}
{{- else -}}
{{ $image.repository }}:{{ $.root.Values.image.tag }}
{{- end -}}
{{- end -}}

{{/* The restricted Pod Security Standard, for every pod: non-root as the images' bun user, the runtime's seccomp profile. */}}
{{- define "answerable.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "answerable.containerSecurityContext" -}}
runAsNonRoot: true
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}

{{/*
The volumes of a pod: a writable /tmp, the database's certificate authority when it talks to the database (database), and
the stack's extra one. The ConfigMap postgres-ca (key ca.pem) is written by the ops bootstrap on first use, before the
migrations and the services mount it; the ops Jobs themselves do not, so bootstrap can run before it exists. Takes root
and database.
*/}}
{{- define "answerable.volumes" -}}
- name: tmp
  emptyDir:
    sizeLimit: 64Mi
{{- if .database }}
- name: postgres-ca
  configMap:
    name: postgres-ca
    items:
      - key: ca.pem
        path: ca.pem
{{- end }}
{{- with .root.Values.extraCaConfigMap }}
- name: extra-ca
  configMap:
    name: {{ . }}
    items:
      - key: ca.pem
        path: ca.pem
{{- end }}
{{- end -}}

{{- define "answerable.volumeMounts" -}}
- name: tmp
  mountPath: /tmp
{{- if .database }}
- name: postgres-ca
  mountPath: /etc/ssl/db
  readOnly: true
{{- end }}
{{- if .root.Values.extraCaConfigMap }}
- name: extra-ca
  mountPath: /etc/ssl/extra
  readOnly: true
{{- end }}
{{- end -}}

{{/* Variables every container gets: the extra certificate authority when there is one. */}}
{{- define "answerable.commonEnv" -}}
{{- if .Values.extraCaConfigMap }}
- name: NODE_EXTRA_CA_CERTS
  value: /etc/ssl/extra/ca.pem
{{- end }}
{{- end -}}

{{/* A value from a Secret, by name and key. */}}
{{- define "answerable.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret }}
      key: {{ .key }}
{{- end -}}

{{/* The parts of a pod spec every workload shares. Takes root and database, as answerable.volumes does. */}}
{{- define "answerable.podCommon" -}}
# Kubernetes would otherwise set <SERVICE>_PORT=tcp://… for every Service in the namespace: TOOLBOX_PORT among them.
enableServiceLinks: false
securityContext:
  {{- include "answerable.podSecurityContext" .root | nindent 2 }}
{{- with .root.Values.hostAliases }}
hostAliases:
  {{- toYaml . | nindent 2 }}
{{- end }}
volumes:
  {{- include "answerable.volumes" . | nindent 2 }}
{{- end -}}

{{/* The servers the ops register Job starts once their client Secrets exist, at the replicas they run: name=replicas,… */}}
{{- define "answerable.opsStartDeployments" -}}
{{- $start := list -}}
{{- range $server := list (dict "name" "toolbox" "values" .Values.toolbox) (dict "name" "admin-mcp" "values" .Values.adminMcp) -}}
{{- $replicas := ternary $server.values.autoscaling.minReplicas $server.values.replicas (and $server.values.autoscaling.enabled true) -}}
{{- $start = append $start (printf "%s=%v" $server.name $replicas) -}}
{{- end -}}
{{- join "," $start -}}
{{- end -}}
