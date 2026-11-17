# frozen_string_literal: true

require "socket"
require "minitest/autorun"
require "sooner_email"

class TestClient < Minitest::Test
  KEY = "sn_abcdefghijklmnop"

  def server(status: 200, response: '{"id":"email1"}', headers: {}, delay: 0)
    listener = TCPServer.new("127.0.0.1", 0)
    requests = Queue.new
    worker = Thread.new do
      loop do
        socket = listener.accept
        begin
          method, path = socket.gets.split(" ")
          received_headers = {}
          while (line = socket.gets) && line != "\r\n"
            name, value = line.split(":", 2)
            received_headers[name.downcase] = value.strip
          end
          body = socket.read(received_headers.fetch("content-length", "0").to_i)
          requests << {method: method, path: path, headers: received_headers, body: body}
          sleep(delay) if delay.positive?
          socket.write("HTTP/1.1 #{status} Test\r\nContent-Length: #{response.bytesize}\r\nConnection: close\r\n")
          headers.each { |name, value| socket.write("#{name}: #{value}\r\n") }
          socket.write("\r\n#{response}")
        ensure
          socket.close
        end
      end
    rescue IOError, Errno::EBADF, Errno::EPIPE
      nil
    end
    yield "http://127.0.0.1:#{listener.addr[1]}", requests
  ensure
    listener&.close
    worker&.kill
    worker&.join
  end

  def test_six_email_endpoint_contracts
    server do |origin, requests|
      client = SoonerEmail::Client.new(KEY, base_url: origin)
      email = {from: "a@example.com", to: ["b@example.com"], subject: "Hi", text: "Hello", reply_to: ["c@example.com"]}
      assert_equal "email1", client.emails.send(email, idempotency_key: "order-123").fetch("id")
      sent = requests.pop
      assert_equal "POST", sent[:method]
      assert_equal "/emails", sent[:path]
      assert_equal "Bearer #{KEY}", sent[:headers]["authorization"]
      assert_equal "order-123", sent[:headers]["idempotency-key"]
      assert_equal ["c@example.com"], JSON.parse(sent[:body])["reply_to"]
      client.emails.send_batch([email], idempotency_key: "batch-123")
      batch = requests.pop
      assert_equal "/emails/batch", batch[:path]
      assert_equal "batch-123", batch[:headers]["idempotency-key"]
      assert_kind_of Array, JSON.parse(batch[:body])
      client.emails.list(limit: 2, after: "email1")
      list = requests.pop
      assert_equal "GET", list[:method]
      assert_equal "/emails?limit=2&after=email1", list[:path]
      client.emails.get("email1")
      assert_equal "/emails/email1", requests.pop[:path]
      client.emails.reschedule("email1", scheduled_at: "in 2 hours")
      update = requests.pop
      assert_equal "PATCH", update[:method]
      assert_equal({"scheduled_at" => "in 2 hours"}, JSON.parse(update[:body]))
      client.emails.cancel("email1")
      cancel = requests.pop
      assert_equal "POST", cancel[:method]
      assert_equal "/emails/email1/cancel", cancel[:path]
      refute_includes client.inspect, KEY
    end
  end

  def test_api_errors_and_no_retries
    server(status: 429, response: '{"name":"rate_limit_exceeded","message":"Slow down"}', headers: {"Retry-After" => "12"}) do |origin, requests|
      client = SoonerEmail::Client.new(KEY, base_url: origin)
      error = assert_raises(SoonerEmail::APIError) { client.emails.get("email1") }
      assert_equal 429, error.status
      assert_equal "rate_limit_exceeded", error.code
      assert_equal "Slow down", error.message
      assert_equal "12", error.retry_after
      assert_equal 1, requests.length
    end
  end

  def test_redirect_never_forwards_key
    server do |target, target_requests|
      server(status: 302, headers: {"Location" => target}) do |origin, requests|
        client = SoonerEmail::Client.new(KEY, base_url: origin)
        error = assert_raises(SoonerEmail::APIError) { client.emails.get("email1") }
        assert_equal 302, error.status
        assert_equal 1, requests.length
        assert_equal 0, target_requests.length
      end
    end
  end

  def test_timeout_and_invalid_json
    server(delay: 0.2) do |origin, requests|
      client = SoonerEmail::Client.new(KEY, base_url: origin, timeout: 0.03)
      error = assert_raises(SoonerEmail::TransportError) { client.emails.get("email1") }
      assert_equal "timeout_error", error.code
      assert_nil error.cause
      assert_equal 1, requests.length
    end
    server(response: "invalid") do |origin, _|
      client = SoonerEmail::Client.new(KEY, base_url: origin)
      assert_raises(SoonerEmail::TransportError) { client.emails.get("email1") }
    end
  end

  def test_error_redaction
    server(response: "invalid echo #{KEY}") do |origin, _|
      client = SoonerEmail::Client.new(KEY, base_url: origin)
      error = assert_raises(SoonerEmail::TransportError) { client.emails.get("email1") }
      refute_includes error.full_message, KEY
      assert_nil error.cause
    end
    server(status: 400, response: JSON.generate({name: KEY, message: KEY}), headers: {"Retry-After" => KEY}) do |origin, _|
      client = SoonerEmail::Client.new(KEY, base_url: origin)
      error = assert_raises(SoonerEmail::APIError) { client.emails.get("email1") }
      refute_includes error.message + error.code + error.retry_after, KEY
    end
  end

  def test_validation_before_network
    ["http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?q=1"].each do |origin|
      assert_raises(ArgumentError) { SoonerEmail::Client.new(KEY, base_url: origin) }
    end
    client = SoonerEmail::Client.new(KEY)
    ["..", "x/y", "%2e%2e", "email\n"].each do |id|
      assert_raises(ArgumentError) { client.emails.get(id) }
    end
    assert_raises(ArgumentError) { client.emails.send_batch([{scheduled_at: "tomorrow"}]) }
    assert_raises(ArgumentError) { client.emails.list(limit: 101) }
    assert_raises(ArgumentError) { client.emails.send({}, idempotency_key: "key\n") }
    assert_raises(ArgumentError) { SoonerEmail::Client.new(KEY, timeout: Float::INFINITY) }
  end
end
