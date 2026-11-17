# frozen_string_literal: true

require "ipaddr"
require "json"
require "net/http"
require "timeout"
require "uri"

module SoonerEmail
  VERSION = "0.1.0"
  DEFAULT_BASE_URL = "https://api.sooner.dev"
  MAX_RESPONSE_BYTES = 4 * 1024 * 1024

  class APIError < StandardError
    attr_reader :status, :code, :retry_after

    def initialize(status:, code:, message:, retry_after: nil)
      @status = status
      @code = code
      @retry_after = retry_after
      super(message)
    end
  end

  # Request failures may leave a write outcome unknown. Reuse the original
  # idempotency key and exact payload when retrying a send.
  class TransportError < StandardError
    attr_reader :code

    def initialize(message, code: "invalid_response")
      @code = code
      super(message)
    end
  end

  class Client
    attr_reader :emails

    def initialize(api_key, base_url: DEFAULT_BASE_URL, timeout: 30)
      unless api_key.is_a?(String) && api_key.match?(/\Asn_[A-Za-z0-9_-]{16,200}\z/)
        raise ArgumentError, "A native sn_ project API key is required"
      end
      @base = URI.parse(base_url)
      unless valid_origin?(@base)
        raise ArgumentError, "Base URL must be an HTTPS origin or a loopback HTTP origin"
      end
      unless timeout.is_a?(Numeric) && timeout.finite? && timeout.positive?
        raise ArgumentError, "Timeout must be finite and positive"
      end
      @api_key = api_key.dup.freeze
      @timeout = timeout
      @emails = Emails.new(self)
    rescue URI::InvalidURIError
      raise ArgumentError, "Invalid API origin"
    end

    def inspect
      "#<SoonerEmail::Client base_url=#{@base}>"
    end

    def request(method, path, body: nil, idempotency_key: nil)
      if idempotency_key && (!idempotency_key.is_a?(String) ||
          idempotency_key.empty? || idempotency_key.bytesize > 256 ||
          idempotency_key.match?(/[\r\n]/))
        raise ArgumentError, "Idempotency key must contain 1 to 256 bytes without newlines"
      end
      request = Net::HTTPGenericRequest.new(method, !body.nil?, true, path)
      request["Authorization"] = "Bearer #{@api_key}"
      request["Accept"] = "application/json"
      request["User-Agent"] = "sooner-ruby/#{VERSION}"
      request["Idempotency-Key"] = idempotency_key if idempotency_key
      unless body.nil?
        request["Content-Type"] = "application/json"
        request.body = JSON.generate(body)
      end
      http = Net::HTTP.new(@base.hostname, @base.port, nil)
      http.use_ssl = @base.scheme == "https"
      http.open_timeout = @timeout
      http.read_timeout = @timeout
      http.write_timeout = @timeout
      http.max_retries = 0
      data = +""
      response = nil

      Timeout.timeout(@timeout) do
        http.start do
          http.request(request) do |received|
            response = received
            received.read_body do |chunk|
              data << chunk
              if data.bytesize > MAX_RESPONSE_BYTES
                raise TransportError, "API response exceeded 4 MiB; a write outcome may be unknown"
              end
            end
          end
        end
      end

      status = response.code.to_i
      unless (200...300).cover?(status)
        failure = begin
          JSON.parse(data)
        rescue JSON::ParserError
          {}
        end
        failure = {} unless failure.is_a?(Hash)
        raise APIError.new(
          status: status,
          code: failure["name"].is_a?(String) ? failure["name"].gsub(@api_key, "[redacted]") : "http_error",
          message: failure["message"].is_a?(String) ? failure["message"].gsub(@api_key, "[redacted]") : "Sooner returned HTTP #{status}",
          retry_after: response["Retry-After"]&.gsub(@api_key, "[redacted]")
        )
      end
      result = JSON.parse(data)
      raise TransportError, "API response must be a JSON object" unless result.is_a?(Hash)
      result
    rescue JSON::ParserError
      raise TransportError, "Invalid API response; a write outcome may be unknown", cause: nil
    rescue Timeout::Error
      raise TransportError.new("Request timed out; a write outcome may be unknown. Reuse its original idempotency key.", code: "timeout_error"), cause: nil
    rescue IOError, SystemCallError, SocketError, EOFError, OpenSSL::SSL::SSLError
      raise TransportError.new("Request failed; a write outcome may be unknown. Reuse its original idempotency key.", code: "network_error"), cause: nil
    end

    private

    def valid_origin?(uri)
      return false unless uri.is_a?(URI::HTTP) && uri.host && !uri.userinfo &&
        !uri.query && !uri.fragment && ["", "/"].include?(uri.path)
      return true if uri.scheme == "https"
      return true if uri.hostname == "localhost"
      IPAddr.new(uri.hostname).loopback?
    rescue IPAddr::InvalidAddressError
      false
    end
  end

  class Emails
    def initialize(client)
      @client = client
    end

    def send(payload, idempotency_key: nil)
      require_payload(payload)
      @client.request("POST", "/emails", body: payload, idempotency_key: idempotency_key)
    end

    def send_batch(payloads, idempotency_key: nil)
      unless payloads.is_a?(Array) && (1..100).cover?(payloads.length)
        raise ArgumentError, "Batch must contain 1 to 100 emails"
      end
      payloads.each do |payload|
        require_payload(payload)
        if ["attachments", "scheduled_at", "scheduledAt"].any? { |key| payload.key?(key) || payload.key?(key.to_sym) }
          raise ArgumentError, "Batch emails cannot include attachments or scheduled_at"
        end
      end
      @client.request("POST", "/emails/batch", body: payloads, idempotency_key: idempotency_key)
    end

    def list(limit: nil, after: nil)
      query = {}
      unless limit.nil?
        raise ArgumentError, "Limit must be between 1 and 100" unless limit.is_a?(Integer) && (1..100).cover?(limit)
        query["limit"] = limit
      end
      unless after.nil?
        identifier(after)
        query["after"] = after
      end
      suffix = query.empty? ? "" : "?#{URI.encode_www_form(query)}"
      @client.request("GET", "/emails#{suffix}")
    end

    def get(id)
      @client.request("GET", "/emails/#{identifier(id)}")
    end

    def reschedule(id, scheduled_at:)
      unless scheduled_at.is_a?(String) && !scheduled_at.empty?
        raise ArgumentError, "Scheduled time is required"
      end
      @client.request("PATCH", "/emails/#{identifier(id)}", body: {scheduled_at: scheduled_at})
    end

    def cancel(id)
      @client.request("POST", "/emails/#{identifier(id)}/cancel")
    end

    private

    def identifier(id)
      unless id.is_a?(String) && id.match?(/\A[A-Za-z0-9][A-Za-z0-9_-]{0,127}\z/)
        raise ArgumentError, "Invalid email identifier"
      end
      id
    end

    def require_payload(payload)
      raise ArgumentError, "Email payload must be a Hash" unless payload.is_a?(Hash)
    end
  end
end
