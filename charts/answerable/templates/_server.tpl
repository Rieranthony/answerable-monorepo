{{/*
One server: its ServiceAccount, Deployment, Service, Ingress, HorizontalPodAutoscaler and PodDisruptionBudget.
Takes root, component (the resource name), image, command (optional: the servers of the mcps image each name theirs), port,
values (its block of values), host, paths (optional: the Ingress's Prefix paths on host, / unless given), env (rendered
variables), readiness (the readiness path), liveness (an HTTP path, or empty for a TCP check), clientSecret (the Secret holding
its ID client secret, or empty) and podAnnotations (optional). Traefik streams responses as they come, which the MCP
endpoints' server-sent events need. The Ingress serves the shared certificate ingress.tlsSecret and names no TLS option:
Traefik's default one, which charts/platform renders, demands Cloudflare's origin-pull certificate.
A server whose client Secret does not exist yet waits at zero replicas rather than failing to start: the ops register Job
writes the Secret and scales it up (infra/ops/README.md), and the next upgrade, finding the Secret, renders it as usual.
`helm template` has no cluster to look in, so it renders such a server at zero.
*/}}
{{- define "answerable.server" -}}
{{- $root := .root -}}
{{- $values := .values -}}
{{- $scope := dict "root" $root "component" .component -}}
{{- $waiting := and .clientSecret (not (lookup "v1" "Secret" $root.Release.Namespace .clientSecret)) -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
automountServiceAccountToken: false
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
spec:
  {{- if $waiting }}
  # Until ops register writes the Secret {{ .clientSecret }} and starts this server.
  replicas: 0
  {{- else if not $values.autoscaling.enabled }}
  replicas: {{ $values.replicas }}
  {{- end }}
  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      {{- include "answerable.selectorLabels" $scope | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "answerable.labels" $scope | nindent 8 }}
      {{- with .podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
    spec:
      serviceAccountName: {{ .component }}
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 30
      {{- include "answerable.podCommon" (dict "root" $root "database" true) | nindent 6 }}
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: {{ $root.Values.spreadOverNodes }}
          labelSelector:
            matchLabels:
              {{- include "answerable.selectorLabels" $scope | nindent 14 }}
      containers:
        - name: {{ .component }}
          image: {{ include "answerable.image" (dict "root" $root "name" .image) }}
          imagePullPolicy: {{ $root.Values.image.pullPolicy }}
          {{- with .command }}
          command: {{ toJson . }}
          {{- end }}
          ports:
            - name: http
              containerPort: {{ .port }}
          env:
            {{- .env | nindent 12 }}
            {{- include "answerable.commonEnv" $root | nindent 12 }}
            {{- range $name, $value := $values.env }}
            - name: {{ $name }}
              value: {{ $value | quote }}
            {{- end }}
          {{- with .envFrom }}
          envFrom:
            {{- . | nindent 12 }}
          {{- end }}
          startupProbe:
            httpGet:
              path: {{ .readiness }}
              port: http
            periodSeconds: 2
            failureThreshold: 60
          readinessProbe:
            httpGet:
              path: {{ .readiness }}
              port: http
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            {{- if .liveness }}
            httpGet:
              path: {{ .liveness }}
              port: http
            {{- else }}
            tcpSocket:
              port: http
            {{- end }}
            periodSeconds: 10
            failureThreshold: 3
          # The servers stop within a second of SIGTERM, but Traefik keeps routing to a terminating pod for a few seconds
          # (measured in the kind stack: 2.5 s), and a request that reaches a stopped pod hangs for 30 s. Waiting first
          # lets Traefik deregister the pod while it still answers; the grace period above leaves 25 s for the stop.
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "5"]
          resources:
            {{- toYaml $values.resources | nindent 12 }}
          securityContext:
            {{- include "answerable.containerSecurityContext" $root | nindent 12 }}
          volumeMounts:
            {{- include "answerable.volumeMounts" (dict "root" $root "database" true) | nindent 12 }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- include "answerable.selectorLabels" $scope | nindent 4 }}
  ports:
    - name: http
      port: {{ .port }}
      targetPort: http
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.tls: "true"
spec:
  ingressClassName: {{ $root.Values.ingress.className }}
  tls:
    - hosts:
        - {{ .host }}
      secretName: {{ $root.Values.ingress.tlsSecret }}
  rules:
    - host: {{ .host }}
      http:
        paths:
          {{- range .paths | default (list "/") }}
          - path: {{ . }}
            pathType: Prefix
            backend:
              service:
                name: {{ $.component }}
                port:
                  name: http
          {{- end }}
{{- if $values.autoscaling.enabled }}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ .component }}
  minReplicas: {{ $values.autoscaling.minReplicas }}
  maxReplicas: {{ $values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
{{- end }}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      {{- include "answerable.selectorLabels" $scope | nindent 6 }}
{{- end -}}
